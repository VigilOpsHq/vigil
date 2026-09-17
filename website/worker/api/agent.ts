import type { Env, RequestContext } from '../lib/env';
import { HttpError, json, nowIso, readJson } from '../lib/http';
import { newId, sha256Hex } from '../lib/crypto';
import { requireDb } from '../lib/auth';
import { entitlementFor } from '../lib/plans';
import { formatBytes, sendTelegram } from '../lib/telegram';

// Workers accept request bodies up to 100 MB; parts stay well under that.
export const PART_SIZE = 50 * 1024 * 1024;
const MAX_BACKUP_BYTES = 50 * 1024 ** 3;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*__[A-Za-z0-9][A-Za-z0-9_.-]*__\d{8}-\d{6}(?:_[a-z-]+)?\.(?:sql|archive)\.gz$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

interface AgentServer {
  id: string;
  name: string;
  account_id: string;
  offline_alerted: number;
  telegram_chat_id: string | null;
  email: string;
  emails: string;
}

async function authServer(env: Env, request: Request): Promise<AgentServer> {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token.startsWith('vo_srv_')) throw new HttpError(401, 'Missing or invalid server token');
  const row = await requireDb(env)
    .prepare(
      `SELECT s.id, s.name, s.account_id, s.offline_alerted, a.telegram_chat_id, a.email, a.emails
       FROM servers s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?`
    )
    .bind(await sha256Hex(token))
    .first<AgentServer>();
  if (!row) throw new HttpError(401, 'Unknown server token. Create a new one at vigilops.cloud/app');
  return row;
}

const scheduleKey = (s: Record<string, unknown>) => `${s.container}|${s.every}|${s.time}|${s.day ?? ''}`;

async function limitsFor(env: Env, server: AgentServer) {
  return entitlementFor(requireDb(env), { id: server.account_id, emails: JSON.parse(server.emails || '[]') });
}

// POST /api/agent/heartbeat
export async function heartbeat(ctx: RequestContext): Promise<Response> {
  const server = await authServer(ctx.env, ctx.request);
  const body = await readJson<{ version?: string; hostname?: string; schedules?: unknown[]; utcOffsetMinutes?: number }>(ctx.request);

  const offset = Number.isFinite(body.utcOffsetMinutes) ? Math.max(-840, Math.min(840, Math.round(body.utcOffsetMinutes!))) : 0;

  // Remember when each schedule was first seen, so slots from before it existed never count as missed
  const previous = await requireDb(ctx.env).prepare('SELECT schedules FROM servers WHERE id = ?').bind(server.id).first<{ schedules: string }>();
  const firstSeen = new Map<string, string>();
  try {
    for (const s of JSON.parse(previous?.schedules || '[]')) firstSeen.set(scheduleKey(s), s.firstSeenAt);
  } catch {
    /* ignore corrupt data */
  }
  const now = nowIso();
  const schedules = (Array.isArray(body.schedules) ? body.schedules.slice(0, 200) : [])
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .map((s) => ({
      container: String(s.container ?? '').slice(0, 128),
      every: String(s.every ?? ''),
      time: String(s.time ?? ''),
      day: typeof s.day === 'number' ? s.day : undefined,
      firstSeenAt: firstSeen.get(scheduleKey(s)) ?? now,
    }));

  await requireDb(ctx.env)
    .prepare(
      `UPDATE servers SET agent_version = ?, hostname = ?, schedules = ?, utc_offset_minutes = ?, last_seen_at = ?, offline_alerted = 0
       WHERE id = ?`
    )
    .bind(String(body.version ?? '').slice(0, 40), String(body.hostname ?? '').slice(0, 120), JSON.stringify(schedules), offset, now, server.id)
    .run();

  if (server.offline_alerted) {
    ctx.waitUntil(sendTelegram(ctx.env.CLOUD_TELEGRAM_BOT_TOKEN, server.telegram_chat_id, `🟢 ${server.name} is back online.`));
  }

  const ent = await limitsFor(ctx.env, server);
  return json({ server: { id: server.id, name: server.name }, plan: ent.plan, limits: ent.limits });
}

// POST /api/agent/backups {container, database, file, size, sha256}
export async function startUpload(ctx: RequestContext): Promise<Response> {
  const server = await authServer(ctx.env, ctx.request);
  if (!ctx.env.BACKUPS) throw new HttpError(503, 'Backup storage is not configured');
  const db = requireDb(ctx.env);

  const body = await readJson<{ container?: string; database?: string; file?: string; size?: number; sha256?: string }>(ctx.request);
  const file = String(body.file ?? '');
  const size = Number(body.size);
  if (!FILE_RE.test(file)) throw new HttpError(400, 'Invalid backup file name');
  if (!NAME_RE.test(String(body.container ?? '')) || !NAME_RE.test(String(body.database ?? ''))) throw new HttpError(400, 'Invalid container or database name');
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BACKUP_BYTES) throw new HttpError(400, 'Invalid size');
  const sha = /^[a-f0-9]{64}$/.test(String(body.sha256 ?? '')) ? String(body.sha256) : null;

  const ent = await limitsFor(ctx.env, server);
  if (!ent.limits) throw new HttpError(402, 'Managed backup storage needs a Pro or Team plan.');

  const used = await db
    .prepare("SELECT COALESCE(SUM(size_bytes), 0) AS n FROM backups WHERE account_id = ? AND status IN ('complete', 'uploading')")
    .bind(server.account_id)
    .first<{ n: number }>();
  if ((used?.n ?? 0) + size > ent.limits.storageBytes) {
    throw new HttpError(
      507,
      `Storage full: ${formatBytes(used?.n ?? 0)} of ${formatBytes(ent.limits.storageBytes)} used. Delete old backups or upgrade.`
    );
  }

  const existing = await db
    .prepare('SELECT id, status, r2_key, upload_id FROM backups WHERE server_id = ? AND file = ?')
    .bind(server.id, file)
    .first<{ id: string; status: string; r2_key: string; upload_id: string | null }>();
  if (existing?.status === 'complete') throw new HttpError(409, 'This backup is already stored');
  if (existing) {
    if (existing.upload_id) await ctx.env.BACKUPS.resumeMultipartUpload(existing.r2_key, existing.upload_id).abort().catch(() => undefined);
    await db.prepare('DELETE FROM backups WHERE id = ?').bind(existing.id).run();
  }

  const id = newId('bkp');
  const key = `accounts/${server.account_id}/servers/${server.id}/${file}`;
  const upload = await ctx.env.BACKUPS.createMultipartUpload(key);
  await db
    .prepare(
      `INSERT INTO backups (id, server_id, account_id, container, database_name, file, size_bytes, sha256, r2_key, upload_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading')`
    )
    .bind(id, server.id, server.account_id, body.container, body.database, file, size, sha, key, upload.uploadId)
    .run();

  return json({ id, partSize: PART_SIZE, parts: Math.max(1, Math.ceil(size / PART_SIZE)) }, 201);
}

async function uploadingBackup(ctx: RequestContext, server: AgentServer) {
  const row = await requireDb(ctx.env)
    .prepare("SELECT id, r2_key, upload_id, size_bytes, file, container FROM backups WHERE id = ? AND server_id = ? AND status = 'uploading'")
    .bind(ctx.params.id, server.id)
    .first<{ id: string; r2_key: string; upload_id: string; size_bytes: number; file: string; container: string }>();
  if (!row) throw new HttpError(404, 'Upload not found');
  if (!ctx.env.BACKUPS) throw new HttpError(503, 'Backup storage is not configured');
  return { row, upload: ctx.env.BACKUPS.resumeMultipartUpload(row.r2_key, row.upload_id) };
}

// PUT /api/agent/backups/:id/parts/:part  (raw bytes, up to PART_SIZE)
export async function uploadPart(ctx: RequestContext): Promise<Response> {
  const server = await authServer(ctx.env, ctx.request);
  const part = Number(ctx.params.part);
  if (!Number.isInteger(part) || part < 1 || part > 10000) throw new HttpError(400, 'Invalid part number');
  const length = Number(ctx.request.headers.get('Content-Length'));
  if (!Number.isFinite(length) || length <= 0 || length > PART_SIZE) throw new HttpError(400, `Each part must be 1 byte to ${PART_SIZE} bytes`);
  if (!ctx.request.body) throw new HttpError(400, 'Empty body');

  const { upload } = await uploadingBackup(ctx, server);
  const uploaded = await upload.uploadPart(part, ctx.request.body);
  return json({ partNumber: uploaded.partNumber, etag: uploaded.etag });
}

// POST /api/agent/backups/:id/complete {parts: [{partNumber, etag}]}
export async function completeUpload(ctx: RequestContext): Promise<Response> {
  const server = await authServer(ctx.env, ctx.request);
  const { row, upload } = await uploadingBackup(ctx, server);
  const { parts } = await readJson<{ parts?: { partNumber: number; etag: string }[] }>(ctx.request);
  if (!Array.isArray(parts) || parts.length === 0) throw new HttpError(400, 'Missing parts');

  const object = await upload.complete(parts.map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) })));
  if (object.size !== row.size_bytes) {
    await ctx.env.BACKUPS?.delete(row.r2_key);
    await requireDb(ctx.env).prepare("UPDATE backups SET status = 'failed', upload_id = NULL WHERE id = ?").bind(row.id).run();
    throw new HttpError(422, `Size mismatch: expected ${row.size_bytes} bytes, stored ${object.size}`);
  }

  await requireDb(ctx.env)
    .prepare("UPDATE backups SET status = 'complete', upload_id = NULL, completed_at = ? WHERE id = ?")
    .bind(nowIso(), row.id)
    .run();
  return json({ id: row.id, file: row.file, size: object.size, status: 'complete' });
}

// POST /api/agent/backups/:id/abort
export async function abortUpload(ctx: RequestContext): Promise<Response> {
  const server = await authServer(ctx.env, ctx.request);
  const { row, upload } = await uploadingBackup(ctx, server);
  await upload.abort().catch(() => undefined);
  await requireDb(ctx.env).prepare('DELETE FROM backups WHERE id = ?').bind(row.id).run();
  return json({ aborted: true });
}

// GET /api/agent/backups?container=
export async function agentListBackups(ctx: RequestContext): Promise<Response> {
  const server = await authServer(ctx.env, ctx.request);
  const container = new URL(ctx.request.url).searchParams.get('container');
  const db = requireDb(ctx.env);
  const stmt = container
    ? db.prepare("SELECT file, container, database_name, size_bytes, completed_at FROM backups WHERE server_id = ? AND container = ? AND status = 'complete' ORDER BY completed_at DESC LIMIT 200").bind(server.id, container)
    : db.prepare("SELECT file, container, database_name, size_bytes, completed_at FROM backups WHERE server_id = ? AND status = 'complete' ORDER BY completed_at DESC LIMIT 200").bind(server.id);
  const { results } = await stmt.all();
  return json({ backups: results });
}

// GET /api/agent/backups/file/:file  — download for restore (any server on the same account)
export async function agentDownload(ctx: RequestContext): Promise<Response> {
  const server = await authServer(ctx.env, ctx.request);
  if (!ctx.env.BACKUPS) throw new HttpError(503, 'Backup storage is not configured');
  const file = decodeURIComponent(ctx.params.file);
  if (!FILE_RE.test(file)) throw new HttpError(400, 'Invalid backup file name');

  const row = await requireDb(ctx.env)
    .prepare(
      `SELECT r2_key FROM backups WHERE account_id = ? AND file = ? AND status = 'complete'
       ORDER BY (server_id = ?) DESC, completed_at DESC LIMIT 1`
    )
    .bind(server.account_id, file, server.id)
    .first<{ r2_key: string }>();
  if (!row) throw new HttpError(404, 'Backup not found in VigilOps Cloud');

  const object = await ctx.env.BACKUPS.get(row.r2_key);
  if (!object) throw new HttpError(404, 'Backup file is missing from storage');
  return new Response(object.body, {
    headers: { 'Content-Type': 'application/gzip', 'Content-Length': String(object.size), 'Cache-Control': 'no-store' },
  });
}
