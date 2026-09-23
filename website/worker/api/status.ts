// Public status of VigilOps Cloud. No authentication: it must stay readable when
// sign-in itself is broken, so it reports only component health and incidents.
//
// Licensed under FSL-1.1-MIT (see website/LICENSE.md): use and self-host freely,
// but not as a competing product or service. Converts to MIT after two years.
import type { RequestContext } from '../lib/env';
import { json } from '../lib/http';

const SCHEDULE_EVERY_MS = 15 * 60 * 1000;

function minutesAgo(ms: number): string {
  if (ms < 60_000) return 'less than a minute';
  const minutes = Math.round(ms / 60_000);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

const PROBE_KEY = '__status_probe';

type State = 'operational' | 'degraded' | 'down' | 'unknown';

interface Component {
  name: string;
  state: State;
  detail: string;
}

interface Incident {
  id: string;
  title: string;
  body: string;
  severity: string;
  started_at: string;
  resolved_at: string | null;
}

// GET /api/status
export async function status(ctx: RequestContext): Promise<Response> {
  const components: Component[] = [
    { name: 'API and dashboard', state: 'operational', detail: 'Answering requests' },
  ];

  let lastRun: string | null = null;
  let incidents: Incident[] = [];

  if (!ctx.env.DB) {
    components.push({ name: 'Database', state: 'unknown', detail: 'Not configured' });
  } else {
    try {
      const row = await ctx.env.DB.prepare("SELECT value FROM meta WHERE key = 'last_cron_run'").first<{ value: string }>();
      lastRun = row?.value ?? null;
      components.push({ name: 'Database', state: 'operational', detail: 'Reads and writes normally' });
    } catch (err) {
      components.push({ name: 'Database', state: 'down', detail: (err as Error).message.slice(0, 120) });
    }

    try {
      const { results } = await ctx.env.DB.prepare(
        `SELECT id, title, body, severity, started_at, resolved_at FROM incidents
         WHERE started_at > datetime('now', '-90 days') ORDER BY started_at DESC LIMIT 20`
      ).all<Incident>();
      incidents = results;
    } catch {
      // The incidents table may not exist yet on an older database
    }
  }

  if (!ctx.env.BACKUPS) {
    components.push({ name: 'Backup storage', state: 'unknown', detail: 'Not configured' });
  } else {
    try {
      await ctx.env.BACKUPS.head(PROBE_KEY); // null is the expected answer; we only check it responds
      components.push({ name: 'Backup storage', state: 'operational', detail: 'Uploads and downloads available' });
    } catch (err) {
      components.push({ name: 'Backup storage', state: 'down', detail: (err as Error).message.slice(0, 120) });
    }
  }

  const age = lastRun ? Date.now() - Date.parse(lastRun) : null;
  components.push({
    name: 'Monitoring and alerts',
    state: age === null ? 'unknown' : age < SCHEDULE_EVERY_MS * 2 ? 'operational' : age < SCHEDULE_EVERY_MS * 8 ? 'degraded' : 'down',
    detail:
      age === null
        ? 'No check has run yet'
        : `Servers and schedules last checked ${minutesAgo(age)} ago`,
  });

  const open = incidents.filter((i) => !i.resolved_at);
  const worst: State = components.some((c) => c.state === 'down')
    ? 'down'
    : components.some((c) => c.state === 'degraded') || open.length
      ? 'degraded'
      : components.some((c) => c.state === 'unknown')
        ? 'unknown'
        : 'operational';

  return json(
    { state: worst, checkedAt: new Date().toISOString(), components, incidents },
    worst === 'down' ? 503 : 200,
    { 'Cache-Control': 'no-store' }
  );
}
