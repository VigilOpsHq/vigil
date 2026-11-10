// Licensed under FSL-1.1-MIT (see website/LICENSE.md): use and self-host freely,
// but not as a competing product or service. Converts to MIT after two years.
import type { Env } from './env';

/** Hourly backups are kept this long; after that, one per database per day. */
export const KEEP_ALL_DAYS = 3;

/**
 * Thin old backups to one per day (the last of each day, per server, container and database).
 *
 * An hourly schedule writes ~720 files a month, and retention alone only removes them after
 * 30 days — so a server backing up hourly filled a 50 GB plan in under a week and every
 * upload after that was rejected. Recent backups stay hourly for quick recovery; older ones
 * only need to be daily.
 *
 * Returns what was removed. Scoped to one server when serverId is given.
 */
export async function thinBackups(env: Env, now = new Date(), serverId?: string): Promise<{ removed: number; bytes: number }> {
  const db = env.DB;
  if (!db) return { removed: 0, bytes: 0 };

  const cutoff = new Date(now.getTime() - KEEP_ALL_DAYS * 86400_000).toISOString();
  let removed = 0;
  let bytes = 0;

  // Batches of 500 so one run stays inside the Worker's limits; the next run carries on.
  for (let round = 0; round < 20; round++) {
    const { results } = await db
      .prepare(
        `SELECT id, r2_key, size_bytes FROM (
           SELECT b.id, b.r2_key, b.size_bytes, ROW_NUMBER() OVER (
             PARTITION BY b.server_id, b.container, b.database_name, substr(b.completed_at, 1, 10)
             ORDER BY b.completed_at DESC
           ) AS rn
           FROM backups b
           WHERE b.status = 'complete' AND b.completed_at < ? ${serverId ? 'AND b.server_id = ?' : ''}
         ) WHERE rn > 1 LIMIT 500`
      )
      .bind(...(serverId ? [cutoff, serverId] : [cutoff]))
      .all<{ id: string; r2_key: string; size_bytes: number }>();
    if (!results.length) break;

    if (env.BACKUPS) await env.BACKUPS.delete(results.map((r) => r.r2_key));
    await db.batch(results.map((r) => db.prepare('DELETE FROM backups WHERE id = ?').bind(r.id)));
    removed += results.length;
    bytes += results.reduce((sum, r) => sum + (r.size_bytes ?? 0), 0);
    if (results.length < 500) break;
  }

  return { removed, bytes };
}
