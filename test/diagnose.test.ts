import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distinctErrors, latestCycle, mergeStreams, redact } from '../src/diagnose/logs';
import { runPlaybooks } from '../src/diagnose/playbooks';
import { fixPrompt, formatTelegram, restartCanHelp } from '../src/diagnose';
import { Diagnosis, Evidence } from '../src/diagnose/types';

// The real zikor-laravel crash loop (Nov 2026), trimmed: the log starts mid-trace and ends at
// the banner of a start that hasn't printed anything yet.
const ZIKOR_CYCLE = [
  '==> Caching config...',
  '',
  'Fatal error: Uncaught ReflectionException: Class "config" does not exist in /var/www/html/vendor/laravel/framework/src/Illuminate/Container/Container.php:912',
  'Stack trace:',
  "#0 /var/www/html/vendor/laravel/framework/src/Illuminate/Container/Container.php(912): ReflectionClass->__construct('config')",
  '#1 /var/www/html/artisan(35): Illuminate\\Foundation\\Console\\Kernel->handle()',
  '#2 {main}',
  '',
  'Next Illuminate\\Contracts\\Container\\BindingResolutionException: Target class [config] does not exist. in /var/www/html/vendor/laravel/framework/src/Illuminate/Container/Container.php:914',
  'Stack trace:',
  "#0 /var/www/html/vendor/laravel/framework/src/Illuminate/Container/Container.php(795): Illuminate\\Container\\Container->build('config')",
  '#1 {main}',
  '  thrown in /var/www/html/vendor/laravel/framework/src/Illuminate/Container/Container.php on line 914',
];
const ZIKOR_LOG = [
  "#5 /var/www/html/vendor/laravel/framework/src/Illuminate/Log/LogManager.php(560): Illuminate\\Container\\Container->offsetGet('config')",
  '#6 {main}',
  ...ZIKOR_CYCLE, ...ZIKOR_CYCLE, ...ZIKOR_CYCLE,
  '==> Caching config...',
];

function evidence(over: Partial<Evidence> = {}): Evidence {
  const logTail = over.logTail ?? [];
  const lastCycle = over.lastCycle ?? latestCycle(logTail);
  return {
    container: 'app', state: 'restarting', exitCode: 1, oomKilled: false, restartCount: 5,
    restartPolicy: 'unless-stopped', image: 'ghcr.io/me/app:latest', imageArch: 'amd64', hostArch: 'amd64',
    startedAt: null, finishedAt: null, dockerError: null, memoryLimitMb: 0, envNames: ['APP_ENV', 'DB_HOST'],
    entrypoint: ['/usr/local/bin/start.sh'], entrypointCrlf: null, changedFiles: [], fileSizes: {}, gaps: [],
    errors: distinctErrors(lastCycle), ...over, logTail, lastCycle,
  };
}

function diagnosis(e: Evidence): Diagnosis {
  return { id: 'abc123', host: 'server-1', createdAt: '2026-11-20T09:00:00.000Z', evidence: e, findings: runPlaybooks(e), context: [] };
}

test('latestCycle returns one complete start of a crash loop, beginning at its banner', () => {
  const cycle = latestCycle(ZIKOR_LOG);
  assert.equal(cycle[0], '==> Caching config...');
  assert.equal(cycle.filter((l) => l === '==> Caching config...').length, 1);
  assert.ok(cycle.some((l) => l.startsWith('Fatal error')));
  assert.ok(cycle.some((l) => l.startsWith('Next ')));
});

test('distinctErrors puts the first error of the start first and skips stack frames', () => {
  const errors = distinctErrors(latestCycle(ZIKOR_LOG));
  assert.match(errors[0], /^Fatal error: Uncaught ReflectionException/);
  assert.match(errors[1], /^Next .*BindingResolutionException/);
  assert.ok(errors.every((e) => !e.startsWith('#')));
});

test('a log that does not loop is returned whole', () => {
  const log = ['Starting server', 'Listening on 3000', 'Error: connect ECONNREFUSED 127.0.0.1:5432'];
  assert.deepEqual(latestCycle(log), log);
});

test('a repeated retry line is not mistaken for a crash loop', () => {
  const log = ['boot', 'Error: missing FOO', 'retrying…', 'retrying…', 'retrying…', 'retrying…', 'retrying…', 'retrying…', 'retrying…', 'retrying…', 'retrying…'];
  assert.deepEqual(latestCycle(log), log);
});

test('mergeStreams interleaves stdout and stderr by timestamp and strips it', () => {
  const out = '2026-11-20T09:00:00.000000001Z starting\n2026-11-20T09:00:02.000000000Z ready';
  const err = '2026-11-20T09:00:01.000000000Z warning: slow';
  assert.deepEqual(mergeStreams(out, err), ['starting', 'warning: slow', 'ready']);
});

test('redact removes secrets from logs', () => {
  const text = [
    'connecting to postgres://app:s3cretPass@db:5432/app',
    'DB_PASSWORD=hunter2 started',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
    'key sk-proj-AbCdEfGhIjKlMnOpQrStUv token ghp_abcdefghijklmnopqrstuvwxyz0123',
    'APP_KEY=base64:YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXphYmNkZWY=',
  ].join('\n');
  const out = redact(text);
  for (const secret of ['s3cretPass', 'hunter2', 'abcdefghijklmnopqrstuvwxyz123456', 'sk-proj-AbCd', 'ghp_abcdef', 'YWJjZGVm']) {
    assert.ok(!out.includes(secret), `leaked ${secret}: ${out}`);
  }
  assert.match(out, /postgres:\/\/app:\*\*\*@db:5432/);
});

test('zikor: an empty Laravel config cache is diagnosed, and a restart is ruled out', () => {
  const e = evidence({
    logTail: ZIKOR_LOG,
    changedFiles: ['/var/www/html/bootstrap/cache/config.php', '/var/www/html/bootstrap/cache/routes-v7.php'],
    fileSizes: { '/var/www/html/bootstrap/cache/config.php': 0, '/var/www/html/bootstrap/cache/routes-v7.php': 0, '/var/www/html/bootstrap/cache/services.php': 20640 },
  });
  const d = diagnosis(e);
  assert.equal(d.findings[0].id, 'laravel-empty-cache');
  assert.equal(d.findings[0].confidence, 'high');
  assert.equal(restartCanHelp(d), false);
  const rm = d.findings[0].commands!.find((c) => c.startsWith('rm '))!;
  assert.match(rm, /config\.php/);
  assert.match(rm, /routes-v7\.php/);
  assert.doesNotMatch(rm, /services\.php/);
  assert.match(d.findings[0].permanentFix, /rm -f .*bootstrap\/cache/);
});

test('zikor after the fix: old crash messages with a rebuilt cache are not a diagnosis', () => {
  const e = evidence({
    state: 'running', logTail: ZIKOR_LOG,
    changedFiles: ['/var/www/html/bootstrap/cache/config.php'],
    fileSizes: { '/var/www/html/bootstrap/cache/config.php': 22092 },
  });
  assert.equal(diagnosis(e).findings.find((f) => f.id === 'laravel-empty-cache'), undefined);
});

const cases: [string, Partial<Evidence>, string][] = [
  ['node out of memory', { logTail: ['<--- Last few GCs --->', 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'], exitCode: 134 }, 'out-of-memory'],
  ['OOM-killed', { oomKilled: true, exitCode: 137, memoryLimitMb: 512 }, 'out-of-memory'],
  ['image built on a Mac', { imageArch: 'arm64', hostArch: 'amd64', logTail: ['exec /usr/local/bin/docker-entrypoint.sh: exec format error'] }, 'wrong-architecture'],
  ['CRLF start script', { exitCode: 127, logTail: ["/usr/local/bin/start.sh: line 2: $'\\r': command not found"] }, 'entrypoint-crlf'],
  ['CRLF shebang (kernel says no such file)', { exitCode: 255, entrypointCrlf: true, logTail: ['exec /start.sh: no such file or directory'] }, 'entrypoint-crlf'],
  ['missing entrypoint', { exitCode: 127, logTail: ['exec /app/start.sh: no such file or directory'] }, 'entrypoint-missing'],
  ['Prisma env var', { logTail: ['Error: Environment variable not found: DATABASE_URL.'] }, 'missing-env'],
  ['Laravel app key', { logTail: ['Illuminate\\Encryption\\MissingAppKeyException: No application encryption key has been specified.'] }, 'missing-env'],
  ['localhost database', { logTail: ['Error: connect ECONNREFUSED 127.0.0.1:5432'] }, 'database-unreachable'],
  ['wrong DB password', { logTail: ['SQLSTATE[HY000] [1045] Access denied for user \'app\'@\'172.18.0.5\''] }, 'database-auth'],
  ['port taken', { logTail: ['Error: listen EADDRINUSE: address already in use :::3000'] }, 'port-in-use'],
  ['dev dependency', { logTail: ["Error: Cannot find module 'dotenv'"] }, 'missing-module'],
  ['prisma on alpine', { logTail: ['Prisma Client could not locate the Query Engine for runtime "linux-musl-openssl-3.0.x".'] }, 'prisma-engine'],
  ['next without build', { logTail: ["Error: Could not find a production build in the '.next' directory."] }, 'nextjs-no-build'],
  ['laravel storage perms', { logTail: ['The stream or file "/var/www/html/storage/logs/laravel.log" could not be opened in append mode: Failed to open stream: Permission denied'] }, 'permission-denied'],
  ['disk full', { logTail: ['Error: ENOSPC: no space left on device, write'] }, 'disk-full'],
];

for (const [name, over, id] of cases) {
  test(`playbook: ${name} → ${id}`, () => {
    const d = diagnosis(evidence(over));
    assert.equal(d.findings[0]?.id, id, JSON.stringify(d.findings.map((f) => f.id)));
  });
}

test('missing env var: says whether the variable exists, never its value', () => {
  const absent = diagnosis(evidence({ logTail: ['Error: Environment variable not found: DATABASE_URL.'] }));
  assert.match(absent.findings[0].title, /DATABASE_URL is not set/);
  const present = diagnosis(evidence({ envNames: ['DATABASE_URL'], logTail: ['Error: Environment variable not found: DATABASE_URL.'] }));
  assert.match(present.findings[0].title, /set but/);
});

test('ordinary log noise matches no playbook', () => {
  const d = diagnosis(evidence({ logTail: ['Server started on :3000', 'GET /api/health 200 3ms', 'Downloading [=====>    ] 50%\r'] }));
  assert.deepEqual(d.findings, []);
  assert.equal(restartCanHelp(d), true);
});

test('an exit code 137 alone (docker kill) is not called out of memory', () => {
  assert.deepEqual(diagnosis(evidence({ exitCode: 137 })).findings, []);
});

test('the Telegram alert is valid, short HTML', () => {
  const d = diagnosis(evidence({ logTail: ['<script>alert(1)</script>', "Error: Cannot find module 'a<b>'"] }));
  const text = formatTelegram(d);
  assert.ok(text.length < 4000);
  assert.doesNotMatch(text, /<script>|<b>'/);
});

test('the fix prompt carries the diagnosis and the first error', () => {
  const d = diagnosis(evidence({ logTail: ZIKOR_LOG, changedFiles: ['/var/www/html/bootstrap/cache/config.php'], fileSizes: { '/var/www/html/bootstrap/cache/config.php': 0 } }));
  const prompt = fixPrompt(d);
  assert.match(prompt, /empty file/);
  assert.match(prompt, /Fatal error: Uncaught ReflectionException/);
  assert.match(prompt, /config\.php — 0 bytes/);
  assert.match(prompt, /APP_ENV, DB_HOST/);
});
