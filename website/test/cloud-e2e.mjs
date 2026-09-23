// End-to-end test of VigilOps Cloud, run against a local `wrangler dev` of the Worker
// (local D1 database and R2 bucket) and the real agent Cloud client from ../dist/cloud.
//
//   BASE=http://127.0.0.1:8787 node test/cloud-e2e.mjs
//
// The Worker must run with BACHS_WEBHOOK_SECRET=testsecret, DEV_LOGIN=true and the
// CLOUD_TELEGRAM_* test values from .github/workflows/ci.yml.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const B = process.env.BASE ?? 'http://127.0.0.1:8787';
const WEBHOOK_SECRET = 'testsecret';
const TELEGRAM_SECRET = 'tgsecret';
const require = createRequire(import.meta.url);

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
}

async function webhook(event) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
  return fetch(`${B}/api/bachs-webhook`, { method: 'POST', headers: { 'X-Bachs-Signature-V2': `t=${t},v1=${sig}` }, body });
}

async function signIn(email) {
  const r = await fetch(`${B}/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  const cookie = r.headers.get('set-cookie')?.split(';')[0];
  return { status: r.status, headers: { Cookie: cookie, Origin: B, 'Content-Type': 'application/json' } };
}

const telegram = (chatId, text) =>
  fetch(`${B}/api/telegram/webhook`, {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': TELEGRAM_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { chat: { id: chatId, type: 'private' }, text } }),
  });

// ── Payments unlock plans ─────────────────────────────────────────────
let r = await webhook({
  id: 'evt_pro_1',
  type: 'customer.subscription.created',
  data: { id: 'sub_pro_1', status: 'active', customer: { customer_id: 'cust_1', email: 'Pro@Example.com' }, metadata: { plan: 'pro', interval: 'monthly' } },
});
check('payment webhook records subscription', r.status === 200);
r = await webhook({ id: 'evt_pro_1', type: 'customer.subscription.created', data: {} });
check('duplicate webhook ignored', (await r.text()) === 'duplicate');
r = await fetch(`${B}/api/bachs-webhook`, { method: 'POST', headers: { 'X-Bachs-Signature-V2': 't=1,v1=bad' }, body: '{}' });
check('unsigned webhook rejected', r.status === 401);

// Bachs doesn't always put the plan in metadata: fall back to the product ID
r = await webhook({
  id: 'evt_team_1',
  type: 'customer.subscription.created',
  data: { id: 'sub_team_1', status: 'active', customer: { email: 'team@example.com' }, items: [{ product_id: 'prod_team_monthly_test' }] },
});
const team = await signIn('team@example.com');
const teamMe = await (await fetch(`${B}/api/me`, { headers: team.headers })).json();
check('plan recognised from the product ID alone', r.status === 200 && teamMe.plan === 'team', teamMe.plan);

const pro = await signIn('pro@example.com');
check('sign-in sets a session', pro.status === 302 && Boolean(pro.headers.Cookie));
let me = await (await fetch(`${B}/api/me`, { headers: pro.headers })).json();
check('plan unlocks by matching email', me.plan === 'pro' && me.limits?.servers === 5, me.plan);

r = await fetch(`${B}/api/app/overview`);
check('dashboard needs sign-in', r.status === 401);
r = await fetch(`${B}/api/app/servers`, { method: 'POST', headers: { ...pro.headers, Origin: 'https://evil.example' }, body: '{"name":"x"}' });
check('cross-site request blocked', r.status === 403);

// ── Servers ───────────────────────────────────────────────────────────
r = await fetch(`${B}/api/app/servers`, { method: 'POST', headers: pro.headers, body: JSON.stringify({ name: 'prod-01' }) });
const { token } = await r.json();
check('add server returns a token', r.status === 201 && token?.startsWith('vo_srv_'));

r = await fetch(`${B}/api/agent/heartbeat`, { method: 'POST', headers: { Authorization: 'Bearer vo_srv_wrong' }, body: '{}' });
check('unknown server token rejected', r.status === 401);

for (let i = 2; i <= 5; i++) await fetch(`${B}/api/app/servers`, { method: 'POST', headers: pro.headers, body: JSON.stringify({ name: `s${i}` }) });
r = await fetch(`${B}/api/app/servers`, { method: 'POST', headers: pro.headers, body: JSON.stringify({ name: 's6' }) });
check('Pro plan stops at 5 servers', r.status === 402);

// ── The real agent client: connect, heartbeat, upload, restore ────────
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-agent-'));
process.env.VIGIL_CLOUD_URL = B;
process.env.BACKUP_DIR = state;
process.env.VIGIL_VERSION = '0.0.0-test';
const cloud = require('../../dist/cloud');
const schedule = require('../../dist/backup/schedule');
const offsite = require('../../dist/backup/offsite');

try {
  await cloud.connect('not-a-token');
  check('agent rejects malformed token', false);
} catch (e) {
  check('agent rejects malformed token', /does not look like/.test(e.message));
}
const status = await cloud.connect(token);
check('vigil cloud connect', status.server.name === 'prod-01' && status.plan === 'pro');

schedule.setSchedule('app-postgres', ['daily', '02:00']);
await cloud.heartbeat();
let overview = await (await fetch(`${B}/api/app/overview`, { headers: pro.headers })).json();
let srv = overview.servers.find((s) => s.name === 'prod-01');
check('heartbeat: online, version and schedule reported', srv.online && srv.agentVersion === '0.0.0-test' && srv.schedules[0]?.container === 'app-postgres');

// 55 MB so the upload uses two parts
const file = 'app-postgres__app__20260917-020000.sql.gz';
const local = path.join(state, file);
const data = crypto.randomBytes(55 * 1024 * 1024);
fs.writeFileSync(local, data);
const sha = crypto.createHash('sha256').update(data).digest('hex');
const copies = await offsite.deliverOffsite(local, file, data.length, { container: 'app-postgres', database: 'app' });
check('backup uploaded to VigilOps Cloud (2 parts)', copies.includes('VigilOps Cloud'), JSON.stringify(copies));

const listed = await cloud.listCloudBackups('app-postgres');
check('vigil cloud backups lists it', listed.length === 1 && listed[0].size_bytes === data.length);

fs.rmSync(local);
const fetched = await offsite.fetchFromStorage(file, local);
check('restore downloads it back, checksum matches', fetched && crypto.createHash('sha256').update(fs.readFileSync(local)).digest('hex') === sha);

overview = await (await fetch(`${B}/api/app/overview`, { headers: pro.headers })).json();
srv = overview.servers.find((s) => s.name === 'prod-01');
check('dashboard shows the backup and storage used', srv.backupCount === 1 && overview.usage.storageBytes === data.length);

const { backups } = await (await fetch(`${B}/api/app/servers/${srv.id}/backups`, { headers: pro.headers })).json();
r = await fetch(`${B}/api/app/backups/${backups[0].id}/download`, { headers: pro.headers });
check('dashboard download matches', crypto.createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex') === sha);
r = await fetch(`${B}/api/app/backups/${backups[0].id}/download`);
check('download needs sign-in', r.status === 401);

// ── Telegram linking through the official bot ─────────────────────────
r = await fetch(`${B}/api/app/telegram/link`, { method: 'POST', headers: pro.headers });
const { url } = await r.json();
const code = url?.split('start=')[1];
check('Connect Telegram returns a bot link', Boolean(code));
r = await fetch(`${B}/api/telegram/webhook`, { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' }, body: '{}' });
check('bot webhook rejects wrong secret', r.status === 401);
await telegram(111, `/start ${code}`);
await telegram(999, `/start ${code}`); // reusing the code must not steal the link
overview = await (await fetch(`${B}/api/app/overview`, { headers: pro.headers })).json();
check('/start links the chat', overview.telegram.connected === true);

// ── Scheduled checks run without errors ───────────────────────────────
// Runs with the chat still linked, so the offline, missed-backup and quota checks all do their work
r = await fetch(`${B}/__scheduled?cron=*/15+*+*+*+*`);
check('15-minute checks run', r.status === 200);

// ── Public status page ──────────────────────────────────────
const st = await (await fetch(`${B}/api/status`)).json();
check('status needs no sign-in and is operational', st.state === 'operational', st.state);
check('status reports monitoring as alive', st.components.some((c) => c.name === 'Monitoring and alerts' && c.state === 'operational'));

await telegram(111, '/stop');
overview = await (await fetch(`${B}/api/app/overview`, { headers: pro.headers })).json();
check('/stop unlinks the chat', overview.telegram.connected === false);

// ── Cancelling locks Cloud features ───────────────────────────────────
await webhook({
  id: 'evt_pro_2',
  type: 'customer.subscription.deleted',
  data: { id: 'sub_pro_1', status: 'canceled', customer: { email: 'pro@example.com' }, metadata: { plan: 'pro', interval: 'monthly' } },
});
me = await (await fetch(`${B}/api/me`, { headers: pro.headers })).json();
check('cancelled subscription locks the plan', me.plan === null);
const file2 = 'app-postgres__app__20260918-020000.sql.gz';
fs.writeFileSync(path.join(state, file2), crypto.randomBytes(1024));
const copies2 = await offsite.deliverOffsite(path.join(state, file2), file2, 1024, { container: 'app-postgres', database: 'app' });
check('uploads stop without a plan', !copies2.includes('VigilOps Cloud'));

cloud.disconnect();
fs.rmSync(state, { recursive: true, force: true });

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
