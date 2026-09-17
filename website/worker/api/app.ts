import type { RequestContext } from '../lib/env';
import { HttpError, json, readJson } from '../lib/http';
import { newId, randomToken, sha256Hex } from '../lib/crypto';
import { requireAccount, requireDb, type Account } from '../lib/auth';
import { entitlementFor } from '../lib/plans';

const ONLINE_WINDOW_MS = 10 * 60 * 1000;

interface ServerRow {
  id: string;
  name: string;
  hostname: string | null;
  agent_version: string | null;
  schedules: string;
  last_seen_at: string | null;
  created_at: string;
  backup_count: number;
  backup_bytes: number | null;
  last_backup_at: string | null;
}

async function ownedServer(ctx: RequestContext, account: Account, serverId: string) {
  const row = await requireDb(ctx.env)
    .prepare('SELECT id, name FROM servers WHERE id = ? AND account_id = ?')
    .bind(serverId, account.id)
    .first<{ id: string; name: string }>();
  if (!row) throw new HttpError(404, 'Server not found');
  return row;
}

// GET /api/app/overview
export async function overview(ctx: RequestContext): Promise<Response> {
  const account = await requireAccount(ctx.env, ctx.request);
  const db = requireDb(ctx.env);
  const ent = await entitlementFor(db, account);

  const { results } = await db
    .prepare(
      `SELECT s.id, s.name, s.hostname, s.agent_version, s.schedules, s.last_seen_at, s.created_at,
              COUNT(b.id) AS backup_count, SUM(b.size_bytes) AS backup_bytes, MAX(b.completed_at) AS last_backup_at
       FROM servers s LEFT JOIN backups b ON b.server_id = s.id AND b.status = 'complete'
       WHERE s.account_id = ?
       GROUP BY s.id ORDER BY s.created_at`
    )
    .bind(account.id)
    .all<ServerRow>();

  const now = Date.now();
  const servers = results.map((s) => ({
    id: s.id,
    name: s.name,
    hostname: s.hostname,
    agentVersion: s.agent_version,
    schedules: JSON.parse(s.schedules || '[]'),
    lastSeenAt: s.last_seen_at,
    online: Boolean(s.last_seen_at && now - Date.parse(s.last_seen_at) < ONLINE_WINDOW_MS),
    connected: Boolean(s.last_seen_at),
    backupCount: s.backup_count,
    backupBytes: s.backup_bytes ?? 0,
    lastBackupAt: s.last_backup_at,
  }));

  return json({
    plan: ent.plan,
    status: ent.status,
    limits: ent.limits,
    currentPeriodEnd: ent.currentPeriodEnd,
    cancelAtPeriodEnd: ent.cancelAtPeriodEnd,
    canManageBilling: Boolean(ent.customerId && ctx.env.BACHS_API_KEY),
    usage: {
      servers: servers.length,
      storageBytes: servers.reduce((sum, s) => sum + s.backupBytes, 0),
    },
    telegram: {
      connected: Boolean(account.telegram_chat_id),
      available: Boolean(ctx.env.CLOUD_TELEGRAM_BOT_TOKEN && ctx.env.CLOUD_TELEGRAM_BOT_USERNAME),
    },
    servers,
  });
}

// POST /api/app/servers {name}
export async function createServer(ctx: RequestContext): Promise<Response> {
  const account = await requireAccount(ctx.env, ctx.request);
  const db = requireDb(ctx.env);
  const ent = await entitlementFor(db, account);
  if (!ent.limits) throw new HttpError(402, 'Connecting servers to VigilOps Cloud needs a Pro or Team plan.');

  const { name } = await readJson<{ name?: string }>(ctx.request);
  const clean = String(name ?? '').trim().slice(0, 60);
  if (!/^[\w .@-]{1,60}$/.test(clean)) throw new HttpError(400, 'Use letters, numbers, spaces, dots, dashes or underscores.');

  const count = await db.prepare('SELECT COUNT(*) AS n FROM servers WHERE account_id = ?').bind(account.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= ent.limits.servers) {
    throw new HttpError(402, `Your plan includes ${ent.limits.servers} servers. Remove one or upgrade.`);
  }

  const token = `vo_srv_${randomToken(32)}`;
  const id = newId('srv');
  await db
    .prepare('INSERT INTO servers (id, account_id, name, token_hash) VALUES (?, ?, ?, ?)')
    .bind(id, account.id, clean, await sha256Hex(token))
    .run();

  return json({ server: { id, name: clean }, token }, 201);
}

// POST /api/app/servers/:id/token  — issue a new token; the old one stops working
export async function rotateServerToken(ctx: RequestContext): Promise<Response> {
  const account = await requireAccount(ctx.env, ctx.request);
  const server = await ownedServer(ctx, account, ctx.params.id);
  const token = `vo_srv_${randomToken(32)}`;
  await requireDb(ctx.env).prepare('UPDATE servers SET token_hash = ? WHERE id = ?').bind(await sha256Hex(token), server.id).run();
  return json({ server, token });
}

// DELETE /api/app/servers/:id
export async function deleteServer(ctx: RequestContext): Promise<Response> {
  const account = await requireAccount(ctx.env, ctx.request);
  const server = await ownedServer(ctx, account, ctx.params.id);
  const db = requireDb(ctx.env);

  const { results } = await db.prepare('SELECT r2_key FROM backups WHERE server_id = ?').bind(server.id).all<{ r2_key: string }>();
  const keys = results.map((r) => r.r2_key);
  if (keys.length && ctx.env.BACKUPS) {
    const bucket = ctx.env.BACKUPS;
    ctx.waitUntil(
      (async () => {
        for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
      })()
    );
  }
  await db.batch([
    db.prepare('DELETE FROM backups WHERE server_id = ?').bind(server.id),
    db.prepare('DELETE FROM servers WHERE id = ?').bind(server.id),
  ]);
  return json({ deleted: true });
}

// GET /api/app/servers/:id/backups
export async function listBackups(ctx: RequestContext): Promise<Response> {
  const account = await requireAccount(ctx.env, ctx.request);
  const server = await ownedServer(ctx, account, ctx.params.id);
  const { results } = await requireDb(ctx.env)
    .prepare(
      `SELECT id, container, database_name, file, size_bytes, sha256, status, created_at, completed_at
       FROM backups WHERE server_id = ? AND status = 'complete' ORDER BY completed_at DESC LIMIT 500`
    )
    .bind(server.id)
    .all();
  return json({ server, backups: results });
}

// GET /api/app/backups/:id/download
export async function downloadBackup(ctx: RequestContext): Promise<Response> {
  const account = await requireAccount(ctx.env, ctx.request);
  if (!ctx.env.BACKUPS) throw new HttpError(503, 'Backup storage is not configured');
  const row = await requireDb(ctx.env)
    .prepare("SELECT file, r2_key FROM backups WHERE id = ? AND account_id = ? AND status = 'complete'")
    .bind(ctx.params.id, account.id)
    .first<{ file: string; r2_key: string }>();
  if (!row) throw new HttpError(404, 'Backup not found');

  const object = await ctx.env.BACKUPS.get(row.r2_key);
  if (!object) throw new HttpError(404, 'Backup file is missing from storage');
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Length': String(object.size),
      'Content-Disposition': `attachment; filename="${row.file.replace(/"/g, '')}"`,
      'Cache-Control': 'no-store',
    },
  });
}

// DELETE /api/app/backups/:id
export async function deleteBackup(ctx: RequestContext): Promise<Response> {
  const account = await requireAccount(ctx.env, ctx.request);
  const db = requireDb(ctx.env);
  const row = await db
    .prepare('SELECT id, r2_key FROM backups WHERE id = ? AND account_id = ?')
    .bind(ctx.params.id, account.id)
    .first<{ id: string; r2_key: string }>();
  if (!row) throw new HttpError(404, 'Backup not found');
  await ctx.env.BACKUPS?.delete(row.r2_key);
  await db.prepare('DELETE FROM backups WHERE id = ?').bind(row.id).run();
  return json({ deleted: true });
}

// POST /api/app/telegram/link
export async function telegramLink(ctx: RequestContext): Promise<Response> {
  const account = await requireAccount(ctx.env, ctx.request);
  const username = ctx.env.CLOUD_TELEGRAM_BOT_USERNAME;
  if (!ctx.env.CLOUD_TELEGRAM_BOT_TOKEN || !username) throw new HttpError(503, 'The VigilOps Telegram bot is not configured');
  const code = randomToken(18);
  const db = requireDb(ctx.env);
  await db.batch([
    db.prepare('DELETE FROM telegram_links WHERE account_id = ? OR expires_at < ?').bind(account.id, new Date().toISOString()),
    db
      .prepare('INSERT INTO telegram_links (code, account_id, expires_at) VALUES (?, ?, ?)')
      .bind(code, account.id, new Date(Date.now() + 15 * 60_000).toISOString()),
  ]);
  return json({ url: `https://t.me/${username.replace(/^@/, '')}?start=${code}` });
}

// POST /api/app/telegram/unlink
export async function telegramUnlink(ctx: RequestContext): Promise<Response> {
  const account = await requireAccount(ctx.env, ctx.request);
  await requireDb(ctx.env).prepare('UPDATE accounts SET telegram_chat_id = NULL WHERE id = ?').bind(account.id).run();
  return json({ connected: false });
}

// POST /api/app/billing-portal
export async function billingPortal(ctx: RequestContext): Promise<Response> {
  const account = await requireAccount(ctx.env, ctx.request);
  const ent = await entitlementFor(requireDb(ctx.env), account);
  if (!ent.customerId || !ctx.env.BACHS_API_KEY) throw new HttpError(404, 'No billing account found');

  const base = (ctx.env.BACHS_API_BASE || 'https://sandbox-api.bachs.io').replace(/\/+$/, '');
  const res = await fetch(`${base}/v1/customers/${encodeURIComponent(ent.customerId)}/portal-sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.env.BACHS_API_KEY}` },
  });
  const body = (await res.json().catch(() => null)) as { url?: string } | null;
  if (!res.ok || !body?.url) {
    console.error(`bachs portal failed: ${res.status} ${JSON.stringify(body)}`);
    throw new HttpError(502, 'Billing portal is not available right now');
  }
  return json({ url: body.url });
}
