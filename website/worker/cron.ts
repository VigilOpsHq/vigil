// Runs every 15 minutes: offline servers, missed scheduled backups, retention, stale uploads.
import type { Env } from './lib/env';
import { LIMITS, type PaidPlan } from './lib/plans';
import { sendTelegram } from './lib/telegram';

const OFFLINE_AFTER_MS = 15 * 60 * 1000;
const GRACE_MS = { hourly: 45 * 60 * 1000, daily: 3 * 3600 * 1000, weekly: 3 * 3600 * 1000 };
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface Schedule {
  container: string;
  every: 'hourly' | 'daily' | 'weekly';
  time: string;
  day?: number;
  firstSeenAt?: string;
}

/** Most recent scheduled slot at or before `now`, for a schedule defined in the server's local time. */
export function lastSlotUtc(s: Schedule, now: Date, utcOffsetMinutes: number): Date {
  const [h, m] = s.time.split(':').map(Number);
  // Shift into "server local time expressed as UTC" so the arithmetic uses UTC getters
  const local = new Date(now.getTime() + utcOffsetMinutes * 60_000);
  const slot = new Date(local);
  slot.setUTCSeconds(0, 0);

  if (s.every === 'hourly') {
    slot.setUTCMinutes(m);
    if (slot > local) slot.setUTCHours(slot.getUTCHours() - 1);
  } else {
    slot.setUTCHours(h, m);
    if (s.every === 'daily') {
      if (slot > local) slot.setUTCDate(slot.getUTCDate() - 1);
    } else {
      slot.setUTCDate(slot.getUTCDate() - ((slot.getUTCDay() - (s.day ?? 0) + 7) % 7));
      if (slot > local) slot.setUTCDate(slot.getUTCDate() - 7);
    }
  }
  return new Date(slot.getTime() - utcOffsetMinutes * 60_000);
}

async function alertOnce(env: Env, key: string, chatId: string | null, text: string): Promise<void> {
  if (!env.DB) return;
  const { meta } = await env.DB.prepare('INSERT OR IGNORE INTO alerts (key) VALUES (?)').bind(key).run();
  if (meta.changes) await sendTelegram(env.CLOUD_TELEGRAM_BOT_TOKEN, chatId, text);
}

export async function runScheduled(env: Env, now = new Date()): Promise<void> {
  const db = env.DB;
  if (!db) return;

  // 1. Servers that stopped checking in
  const offlineBefore = new Date(now.getTime() - OFFLINE_AFTER_MS).toISOString();
  const { results: offline } = await db
    .prepare(
      `SELECT s.id, s.name, s.last_seen_at, a.telegram_chat_id FROM servers s JOIN accounts a ON a.id = s.account_id
       WHERE s.last_seen_at IS NOT NULL AND s.last_seen_at < ? AND s.offline_alerted = 0`
    )
    .bind(offlineBefore)
    .all<{ id: string; name: string; last_seen_at: string; telegram_chat_id: string | null }>();
  for (const s of offline) {
    await db.prepare('UPDATE servers SET offline_alerted = 1 WHERE id = ?').bind(s.id).run();
    const minutes = Math.round((now.getTime() - Date.parse(s.last_seen_at)) / 60_000);
    await sendTelegram(
      env.CLOUD_TELEGRAM_BOT_TOKEN,
      s.telegram_chat_id,
      `🔴 ${s.name} has not checked in for ${minutes} minutes.\nThe server may be down, or VigilOps stopped running on it.`
    );
  }

  // 2. Scheduled backups that never arrived
  const { results: servers } = await db
    .prepare(
      `SELECT s.id, s.name, s.schedules, s.utc_offset_minutes, a.telegram_chat_id
       FROM servers s JOIN accounts a ON a.id = s.account_id WHERE s.schedules != '[]'`
    )
    .all<{ id: string; name: string; schedules: string; utc_offset_minutes: number; telegram_chat_id: string | null }>();

  for (const server of servers) {
    let schedules: Schedule[] = [];
    try {
      schedules = JSON.parse(server.schedules);
    } catch {
      continue;
    }
    for (const s of schedules) {
      if (!s?.container || !GRACE_MS[s.every] || !/^\d{2}:\d{2}$/.test(s.time)) continue;
      const slot = lastSlotUtc(s, now, server.utc_offset_minutes);
      if (now.getTime() < slot.getTime() + GRACE_MS[s.every]) continue;
      if (!s.firstSeenAt || Date.parse(s.firstSeenAt) > slot.getTime()) continue;

      const got = await db
        .prepare("SELECT 1 FROM backups WHERE server_id = ? AND container = ? AND status = 'complete' AND completed_at >= ? LIMIT 1")
        .bind(server.id, s.container, new Date(slot.getTime() - 10 * 60_000).toISOString())
        .first();
      if (got) continue;

      const when = s.every === 'hourly' ? 'hourly' : s.every === 'daily' ? `daily ${s.time}` : `weekly ${DAYS[s.day ?? 0]} ${s.time}`;
      await alertOnce(
        env,
        `missed:${server.id}:${s.container}:${slot.toISOString()}`,
        server.telegram_chat_id,
        `⚠️ Missed backup: ${s.container} on ${server.name}\nScheduled ${when} (server time), but no backup reached VigilOps Cloud.\nCheck with: vigil backups ${s.container}`
      );
    }
  }

  // 3. Retention: delete backups older than the plan allows, always keeping the newest per container
  const { results: accounts } = await db
    .prepare(
      `SELECT a.id, a.emails, (
         SELECT sub.plan FROM subscriptions sub
         WHERE (sub.account_id = a.id OR instr(a.emails, '"' || sub.email || '"') > 0)
           AND sub.status IN ('active', 'trialing', 'past_due')
         ORDER BY CASE sub.plan WHEN 'enterprise' THEN 3 WHEN 'team' THEN 2 ELSE 1 END DESC LIMIT 1
       ) AS plan
       FROM accounts a WHERE EXISTS (SELECT 1 FROM backups b WHERE b.account_id = a.id)`
    )
    .all<{ id: string; plan: string | null }>();

  for (const account of accounts) {
    // Lapsed subscriptions keep backups for the Pro retention period
    const days = LIMITS[(account.plan ?? 'pro') as PaidPlan]?.retentionDays ?? LIMITS.pro.retentionDays;
    const cutoff = new Date(now.getTime() - days * 86400_000).toISOString();
    const { results: expired } = await db
      .prepare(
        `SELECT b.id, b.r2_key FROM backups b
         WHERE b.account_id = ? AND b.status = 'complete' AND b.completed_at < ?
           AND b.id != (SELECT b2.id FROM backups b2 WHERE b2.server_id = b.server_id AND b2.container = b.container
                        AND b2.status = 'complete' ORDER BY b2.completed_at DESC LIMIT 1)
         LIMIT 500`
      )
      .bind(account.id, cutoff)
      .all<{ id: string; r2_key: string }>();
    if (!expired.length) continue;
    if (env.BACKUPS) await env.BACKUPS.delete(expired.map((e) => e.r2_key));
    await db.batch(expired.map((e) => db.prepare('DELETE FROM backups WHERE id = ?').bind(e.id)));
  }

  // 4. Uploads that never finished
  const staleBefore = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const { results: stale } = await db
    .prepare("SELECT id, r2_key, upload_id FROM backups WHERE status IN ('uploading', 'failed') AND created_at < ? LIMIT 200")
    .bind(staleBefore)
    .all<{ id: string; r2_key: string; upload_id: string | null }>();
  for (const b of stale) {
    if (b.upload_id && env.BACKUPS) await env.BACKUPS.resumeMultipartUpload(b.r2_key, b.upload_id).abort().catch(() => undefined);
    await db.prepare('DELETE FROM backups WHERE id = ?').bind(b.id).run();
  }

  // 5. Housekeeping
  const monthAgo = new Date(now.getTime() - 30 * 86400_000).toISOString();
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now.toISOString()),
    db.prepare('DELETE FROM telegram_links WHERE expires_at < ?').bind(now.toISOString()),
    db.prepare('DELETE FROM alerts WHERE created_at < ?').bind(monthAgo),
    db.prepare('DELETE FROM webhook_events WHERE received_at < ?').bind(monthAgo),
  ]);
}
