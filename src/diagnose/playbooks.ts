import { Evidence, Finding } from './types';

/**
 * Known ways an app container fails, each recognised from evidence Vigil already has. A
 * playbook only fires on something specific (a message, an exit code, a file), so a match is a
 * diagnosis, not a guess. Anything else goes to the AI with the same evidence.
 */
export type Playbook = (e: Evidence) => Finding | null;

/** First line in the latest start (then the whole tail) that matches. */
function line(e: Evidence, re: RegExp): string | undefined {
  return e.lastCycle.find((l) => re.test(l)) ?? e.logTail.find((l) => re.test(l));
}

const short = (s: string, max = 240) => (s.length > max ? `${s.slice(0, max)}…` : s);
const quote = (s: string) => `log: "${short(s.trim())}"`;

// ── Laravel: empty cached config ─────────────────────────────────────────────────────────────

const laravelEmptyCache: Playbook = (e) => {
  const cacheFiles = Object.entries(e.fileSizes).filter(([f]) => /\/bootstrap\/cache\/[^/]+\.php$/.test(f));
  const empty = cacheFiles.filter(([, size]) => size === 0).map(([f]) => f);
  const symptom = line(e, /Target class \[config\] does not exist|Class "config" does not exist/);
  if (empty.length === 0 && !symptom) return null;
  // The cache files are there and not empty: the message is from before they were rebuilt.
  const config = cacheFiles.find(([f]) => /\/config\.php$/.test(f));
  if (empty.length === 0 && config && config[1] > 0) return null;
  if (empty.length === 0 && !e.changedFiles.some((f) => /\/bootstrap\/cache\/config\.php$/.test(f))) return null;

  const files = empty.length > 0 ? empty : e.changedFiles.filter((f) => /\/bootstrap\/cache\/(?:config|routes-v\d+|events)\.php$/.test(f));
  return {
    id: 'laravel-empty-cache',
    title: empty.length > 0 ? `Laravel's cached config is an empty file` : `Laravel's cached config is broken`,
    cause: 'Laravel loads bootstrap/cache/config.php before anything else. The file is empty (a write was cut off — the container was stopped or the disk filled while it was being cached), so Laravel gets nothing back instead of its settings and crashes. `config:cache` in the start script has to boot Laravel first, so it can never rewrite the file: every restart fails the same way.',
    evidence: [
      ...empty.map((f) => `${f} is 0 bytes`),
      ...(symptom ? [quote(symptom)] : []),
      e.restartCount > 0 ? `restarted ${e.restartCount} times — a restart does not remove the file` : '',
    ].filter(Boolean),
    fixNow: [
      'Delete the broken cache files and start the container again — Laravel rebuilds them on start.',
      'Or redeploy the app (Coolify, Dokploy, `docker compose up -d --force-recreate`): a new container starts without them.',
    ],
    commands: [
      `UP=$(docker inspect ${e.container} --format '{{.GraphDriver.Data.UpperDir}}')`,
      `docker stop ${e.container}`,
      `rm -f ${files.map((f) => `"$UP${f}"`).join(' ')}`,
      `docker start ${e.container}`,
    ],
    permanentFix: 'In the container start script, delete the cached files before any `php artisan` command, so a broken cache can never block boot: `rm -f /var/www/html/bootstrap/cache/*.php`. Note `php artisan config:clear` does not work for this — it loads the broken file first and crashes too.',
    restartHelps: false,
    confidence: empty.length > 0 ? 'high' : 'medium',
  };
};

// ── Out of memory ───────────────────────────────────────────────────────────────────────────

const outOfMemory: Playbook = (e) => {
  const heap = line(e, /JavaScript heap out of memory|Allowed memory size of \d+ bytes exhausted|MemoryError|java\.lang\.OutOfMemoryError|fatal error: runtime: out of memory/);
  if (!e.oomKilled && !heap && e.exitCode !== 137) return null;
  if (!e.oomKilled && !heap) return null; // 137 alone is also `docker kill`
  const node = heap && /JavaScript heap/.test(heap);
  const php = heap && /Allowed memory size/.test(heap);
  return {
    id: 'out-of-memory',
    title: 'The app runs out of memory',
    cause: e.oomKilled
      ? `The kernel killed the process because the container went over its memory${e.memoryLimitMb ? ` limit (${e.memoryLimitMb} MB)` : ' — the server itself is out of memory'}.`
      : 'The runtime hit its own memory ceiling and stopped.',
    evidence: [
      e.oomKilled ? 'Docker reports OOMKilled = true' : '',
      e.exitCode === 137 ? 'exit code 137 (killed)' : '',
      heap ? quote(heap) : '',
    ].filter(Boolean),
    fixNow: [
      e.memoryLimitMb ? `Raise the container's memory limit (now ${e.memoryLimitMb} MB) in its compose file and redeploy.` : 'Check what else is using memory on the server (`free -m`, `docker stats --no-stream`).',
      node ? 'For Node, set NODE_OPTIONS=--max-old-space-size=<MB> to a value below the container limit.' : '',
      php ? 'For PHP, raise memory_limit, or find the request that loads too much at once.' : '',
    ].filter(Boolean),
    permanentFix: 'Find what grows: a query loading a whole table, a cache without a limit, a leak on every request. Process large data in chunks or streams, and set an explicit memory limit that fits the server.',
    restartHelps: true,
    confidence: 'high',
  };
};

// ── Wrong CPU architecture ──────────────────────────────────────────────────────────────────

const wrongArchitecture: Playbook = (e) => {
  const msg = line(e, /exec format error/) ?? (e.dockerError && /exec format error/.test(e.dockerError) ? e.dockerError : undefined);
  const mismatch = e.imageArch && e.imageArch !== e.hostArch;
  if (!msg && !mismatch) return null;
  if (!mismatch && msg && /\.sh|\/bin\/(ba)?sh/.test(msg)) return null; // a script without a shebang, not the image
  return {
    id: 'wrong-architecture',
    title: `The image was built for ${e.imageArch ?? 'another CPU'}, this server is ${e.hostArch}`,
    cause: 'The image contains programs for a different processor, so the server cannot run them. This happens when an image is built on an Apple Silicon Mac (arm64) and run on an Intel/AMD server (amd64), or the other way round.',
    evidence: [
      mismatch ? `image architecture: ${e.imageArch}, server: ${e.hostArch}` : '',
      msg ? quote(msg) : '',
    ].filter(Boolean),
    fixNow: [`Rebuild and push the image for this server: \`docker buildx build --platform linux/${e.hostArch} -t ${e.image} --push .\`, then redeploy.`],
    permanentFix: `Build for the server's platform in CI or the build script: \`--platform linux/${e.hostArch}\` (or \`linux/amd64,linux/arm64\` for both).`,
    restartHelps: false,
    confidence: 'high',
  };
};

// ── Entrypoint script broken (CRLF line endings, missing file, not executable) ──────────────

const brokenEntrypoint: Playbook = (e) => {
  const exit = e.exitCode;
  const startFailed = exit === 126 || exit === 127;
  // A bare \r is also a progress bar; these are the shell's own CRLF complaints.
  const crlf = line(e, /\$'\\r'|\r: command not found|\r': No such file|\/bin\/(?:ba)?sh\r|\^M|bad interpreter/);
  const missing = line(e, /exec .+: no such file or directory|exec: ".+": (?:stat .+: )?no such file|starting container process caused/)
    ?? (startFailed ? line(e, /: not found\s*$/) : undefined);
  const notExec = startFailed ? line(e, /permission denied/i) : undefined;
  if (!crlf && !e.entrypointCrlf && !missing && !(startFailed && (notExec || e.dockerError))) return null;
  const script = e.entrypoint.find((p) => /\.sh$|^\/usr\/local\/bin\/|^\.\//.test(p)) ?? e.entrypoint.join(' ');
  if (crlf || e.entrypointCrlf) {
    return {
      id: 'entrypoint-crlf',
      title: 'The start script has Windows line endings',
      cause: `${script || 'The start script'} was saved with Windows line endings (CRLF). Linux reads the invisible \\r as part of each line, so it looks for an interpreter called "/bin/sh\\r" — and reports "no such file or directory" for a file that is there.`,
      evidence: [
        e.entrypointCrlf ? `the first line of ${script} ends in \\r` : '',
        crlf ? quote(crlf) : missing ? quote(missing) : '',
        exit !== null ? `exit code ${exit}` : '',
      ].filter(Boolean),
      fixNow: ['Convert the script to Unix line endings (`dos2unix <file>`, or change "CRLF" to "LF" in your editor), rebuild the image and redeploy.'],
      permanentFix: 'Add a `.gitattributes` with `*.sh text eol=lf` so Git never checks scripts out with CRLF, or run `sed -i "s/\\r$//" <script>` in the Dockerfile.',
      restartHelps: false,
      confidence: 'high',
    };
  }
  return {
    id: 'entrypoint-missing',
    title: 'The container cannot start its command',
    cause: missing
      ? `The command the container starts with (${script || 'its entrypoint'}) is not in the image, or its first line points to an interpreter the image doesn't have (e.g. #!/bin/bash on Alpine, which only has /bin/sh).`
      : `The start script is not executable (exit ${exit}).`,
    evidence: [missing ? quote(missing) : notExec ? quote(notExec) : '', e.dockerError ? `Docker: ${short(e.dockerError)}` : '', exit !== null ? `exit code ${exit}` : ''].filter(Boolean),
    fixNow: ['Check the Dockerfile COPY path and the script\'s first line, rebuild and redeploy.'],
    permanentFix: 'In the Dockerfile: `COPY` the script to the path the CMD uses, `RUN chmod +x` it, and make its shebang match a shell the image has (`#!/bin/sh` on Alpine).',
    restartHelps: false,
    confidence: 'high',
  };
};

// ── Missing environment variable / app key ──────────────────────────────────────────────────

const ENV_PATTERNS: RegExp[] = [
  /Environment variable not found: ([A-Z][A-Z0-9_]+)/,                        // Prisma
  /\b([A-Z][A-Z0-9_]{2,})\b (?:environment variable )?(?:is )?(?:not set|missing|required|undefined|not defined)/,
  /(?:missing|required|undefined) (?:required )?(?:env(?:ironment)? (?:var(?:iable)?)?|config(?:uration)? )["'`]?([A-Z][A-Z0-9_]{2,})/i,
  /KeyError: ['"]([A-Z][A-Z0-9_]+)['"]/,                                      // Python os.environ
  /Invalid environment variables?:?\s*\{?\s*["']?([A-Z][A-Z0-9_]+)/,          // t3 / zod env
];

const NOT_A_VARIABLE = new Set(['ERROR', 'FATAL', 'WARN', 'WARNING', 'INFO', 'DEBUG', 'NULL', 'TRUE', 'FALSE', 'HTTP', 'JSON', 'SQL', 'URL', 'API']);

const missingEnv: Playbook = (e) => {
  const appKey = line(e, /No application encryption key has been specified|MissingAppKeyException/);
  let name: string | undefined;
  let msg: string | undefined;
  for (const re of ENV_PATTERNS) {
    msg = line(e, re);
    name = msg ? re.exec(msg)?.[1] : undefined;
    if (name) break;
  }
  if (name && NOT_A_VARIABLE.has(name)) name = undefined;
  if (appKey) { name = 'APP_KEY'; msg = appKey; }
  if (!name || !msg) return null;
  const isSet = e.envNames.includes(name);
  return {
    id: 'missing-env',
    title: isSet ? `${name} is set but the app rejects its value` : `${name} is not set`,
    cause: isSet
      ? `The container has ${name}, but the app says it is missing or invalid — usually empty, quoted wrongly, or in the wrong format.`
      : `The app needs ${name} to start, and the container does not have it.`,
    evidence: [quote(msg), isSet ? `${name} is present in the container (value not shown)` : `${name} is not among the container's ${e.envNames.length} environment variables`],
    fixNow: [isSet ? `Check the value of ${name} in the app's .env or deploy settings and redeploy.` : `Add ${name} to the app's .env (or Coolify/Dokploy environment) and redeploy — a restart alone won't pick it up.`, name === 'APP_KEY' ? 'Generate one with `php artisan key:generate --show`.' : ''].filter(Boolean),
    permanentFix: `List ${name} in .env.example, and validate required variables at startup with a clear message.`,
    restartHelps: false,
    confidence: 'high',
  };
};

// ── Database / cache unreachable ────────────────────────────────────────────────────────────

const SERVICE_PORTS: Record<string, string> = { '5432': 'Postgres', '3306': 'MySQL', '6379': 'Redis', '27017': 'MongoDB', '5672': 'RabbitMQ' };

const databaseUnreachable: Playbook = (e) => {
  const refused = line(e, /ECONNREFUSED\s*\[?([\d.:a-f]+)\]?:(\d+)|Connection refused|SQLSTATE\[HY000\] \[2002\]|could not connect to server|Can't reach database server|P1001|connect ECONNREFUSED/i);
  const dns = line(e, /getaddrinfo (?:ENOTFOUND|EAI_AGAIN) (\S+)|php_network_getaddresses|Name or service not known|could not translate host name/);
  const auth = line(e, /password authentication failed|Access denied for user|SQLSTATE\[28000\]|SQLSTATE\[HY000\] \[1045\]|P1000|WRONGPASS|NOAUTH/);
  const msg = auth ?? refused ?? dns;
  if (!msg) return null;

  const port = /:(\d{4,5})\b/.exec(msg)?.[1];
  const what = (port && SERVICE_PORTS[port]) || (/redis/i.test(msg) ? 'Redis' : /mysql|SQLSTATE|1045/i.test(msg) ? 'MySQL' : /postgres|P100/i.test(msg) ? 'Postgres' : 'the database');
  const localhost = /127\.0\.0\.1|::1|localhost/.test(msg);

  if (auth) {
    return {
      id: 'database-auth',
      title: `${what} rejects the app's username or password`,
      cause: `The app reaches ${what}, but the credentials it uses are wrong — usually the password was changed on one side only, or the database volume was created with older credentials (the POSTGRES_PASSWORD / MYSQL_PASSWORD settings only apply the first time a volume is created).`,
      evidence: [quote(auth)],
      fixNow: [`Make the app's database credentials match the database, then redeploy the app.`],
      permanentFix: 'Keep the database credentials in one place that both the app and the database read, and document that changing them later needs an ALTER USER, not just a new env value.',
      restartHelps: false,
      confidence: 'high',
    };
  }
  return {
    id: 'database-unreachable',
    title: `The app can't reach ${what}`,
    cause: localhost
      ? `The app connects to ${what} at localhost. Inside a container, localhost is the container itself, not the server — so nothing is listening there.`
      : dns
        ? `The database host name doesn't resolve: the app and ${what} are not on the same Docker network, or the host name is misspelled.`
        : `Nothing is accepting connections where the app looks for ${what}: it is down, still starting, or listening somewhere else.`,
    evidence: [quote(msg)],
    fixNow: localhost
      ? [`Set the database host to the database container's name (e.g. DB_HOST=postgres) instead of localhost, and redeploy.`]
      : [`Check that the ${what} container is running (\`docker ps\`) and on the same network as the app (\`docker network inspect <network>\`).`],
    permanentFix: localhost
      ? 'Use the compose service name as the database host, and add `depends_on` with a health check so the app waits for the database.'
      : 'Put the app and database on one Docker network, add `depends_on: { db: { condition: service_healthy } }`, and retry the connection at startup instead of exiting.',
    restartHelps: !localhost && !dns,
    confidence: localhost || dns ? 'high' : 'medium',
  };
};

// ── Port already in use ─────────────────────────────────────────────────────────────────────

const portInUse: Playbook = (e) => {
  const msg = line(e, /EADDRINUSE|address already in use|Address in use|port is already allocated/i);
  if (!msg) return null;
  const port = /:(\d{2,5})\b/.exec(msg)?.[1] ?? /port (\d{2,5})/i.exec(msg)?.[1];
  return {
    id: 'port-in-use',
    title: `Port ${port ?? ''} is already taken`.replace('  ', ' '),
    cause: 'Something else is already listening on the port the app wants: another container, a host service, or a second copy of the app started inside the same container.',
    evidence: [quote(msg)],
    fixNow: [`Find what holds it: \`ss -ltnp | grep :${port ?? '<port>'}\` and \`docker ps --filter publish=${port ?? '<port>'}\`. Stop the old one, or move the app to another port.`],
    permanentFix: 'Read the port from an env var (PORT), and make sure the start script launches the server once (supervisor configs and `npm start` inside another process manager often start it twice).',
    restartHelps: false,
    confidence: 'high',
  };
};

// ── Missing module / dependency ─────────────────────────────────────────────────────────────

const missingModule: Playbook = (e) => {
  const msg = line(e, /Cannot find module ['"]([^'"]+)['"]|ERR_MODULE_NOT_FOUND|Cannot find package ['"]([^'"]+)['"]|ModuleNotFoundError: No module named ['"]([^'"]+)['"]|Class ["']([^"']+)["'] not found|Failed opening required ['"]([^'"]+)['"]/);
  if (!msg) return null;
  const mod = /['"]([^'"]+)['"]/.exec(msg)?.[1];
  const php = /Class .+ not found|Failed opening required/.test(msg);
  return {
    id: 'missing-module',
    title: `${mod ? `\`${mod}\`` : 'A dependency'} is missing from the image`,
    cause: php
      ? 'PHP cannot load a class: the package is not installed in the image, it is a dev dependency (composer install --no-dev drops it), or the autoloader is stale.'
      : 'The app imports a package the image doesn\'t contain. Usually it is listed under devDependencies (dropped by `npm ci --omit=dev` / `npm prune --production`), was never added to package.json, or the build output is missing a file.',
    evidence: [quote(msg)],
    fixNow: ['Add the package to the production dependencies, rebuild the image and redeploy.'],
    permanentFix: php
      ? 'Move the package from require-dev to require, and run `composer dump-autoload --optimize` in the Dockerfile after copying the code.'
      : 'Move the package from devDependencies to dependencies, and build in CI with the same install command the Dockerfile uses so a missing package fails the build, not production.',
    restartHelps: false,
    confidence: 'high',
  };
};

// ── Prisma engine / migrations ──────────────────────────────────────────────────────────────

const prisma: Playbook = (e) => {
  const engine = line(e, /Prisma Client could not locate the Query Engine|libssl\.so\.[\d.]+: cannot open shared object|Unable to require\(`.+libquery_engine|binaryTargets/);
  const migration = line(e, /P3009|P3018|migrate found failed migrations|The migration .+ failed/);
  if (!engine && !migration) return null;
  if (engine) {
    return {
      id: 'prisma-engine',
      title: 'Prisma\'s query engine doesn\'t match the image',
      cause: 'Prisma downloads a native engine for the machine where `prisma generate` ran. The image runs on a different system (often Alpine/musl, or a different OpenSSL), so the engine can\'t load.',
      evidence: [quote(engine)],
      fixNow: ['Add the right binaryTargets and rebuild the image.'],
      permanentFix: 'In schema.prisma: `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]` (Alpine) or `"debian-openssl-3.0.x"` (Debian), run `prisma generate` inside the Dockerfile, and install openssl in the image.',
      restartHelps: false,
      confidence: 'high',
    };
  }
  return {
    id: 'prisma-failed-migration',
    title: 'A database migration failed and blocks the rest',
    cause: 'Prisma recorded a migration as failed, and refuses to apply anything until it is resolved — so the app exits at startup.',
    evidence: [quote(migration!)],
    fixNow: ['Look at the failed migration (`npx prisma migrate status`), fix the database by hand if it half-applied, then `npx prisma migrate resolve --rolled-back <name>` (or `--applied`) and redeploy.'],
    permanentFix: 'Run migrations as a separate deploy step that stops the deploy when it fails, rather than in the app\'s start command; test migrations against a copy of production data.',
    restartHelps: false,
    confidence: 'high',
  };
};

// ── Next.js without a build ─────────────────────────────────────────────────────────────────

const nextNoBuild: Playbook = (e) => {
  const msg = line(e, /Could not find a production build in the ['"]?\.next['"]? directory/);
  if (!msg) return null;
  return {
    id: 'nextjs-no-build',
    title: 'Next.js starts without a production build',
    cause: '`next start` needs the output of `next build`, and the image doesn\'t have it: the build step is missing, failed silently, or the .next folder was not copied into the final image stage.',
    evidence: [quote(msg)],
    fixNow: ['Run `next build` in the Dockerfile (or switch to `output: "standalone"`), rebuild and redeploy.'],
    permanentFix: 'In the Dockerfile: `RUN npm run build` in the build stage and `COPY --from=build /app/.next ./.next` (or the standalone folder) into the final stage. Check .dockerignore doesn\'t exclude what the build needs.',
    restartHelps: false,
    confidence: 'high',
  };
};

// ── Permissions ─────────────────────────────────────────────────────────────────────────────

const permissionDenied: Playbook = (e) => {
  const msg = line(e, /EACCES|Permission denied|could not be opened in append mode|failed to open stream: Permission denied|Read-only file system|EROFS/);
  if (!msg) return null;
  const path = /(\/[\w.@/-]+)/.exec(msg)?.[1];
  const laravel = /storage\/|bootstrap\/cache/.test(msg);
  return {
    id: 'permission-denied',
    title: `The app can't write to ${path ? `\`${path}\`` : 'a folder it needs'}`,
    cause: laravel
      ? 'Laravel writes logs, sessions and caches under storage/ and bootstrap/cache/, and the web server user (www-data) doesn\'t own them — common after a volume is mounted over storage/ or files are created as root.'
      : 'The process runs as a user that may not write there: the folder belongs to root, a volume is mounted with other ownership, or the file system is read-only.',
    evidence: [quote(msg)],
    fixNow: [laravel
      ? `Fix ownership: \`docker exec ${e.container} chown -R www-data:www-data storage bootstrap/cache\` (while it is running), then restart it.`
      : 'Give the app\'s user ownership of that folder (or the volume), then restart.'],
    permanentFix: laravel
      ? 'In the Dockerfile and the start script: `chown -R www-data:www-data storage bootstrap/cache` after volumes are mounted, and run artisan commands as www-data.'
      : 'Create the folders in the Dockerfile with `chown` to the user the app runs as (`USER`), and mount volumes with matching ownership.',
    restartHelps: false,
    confidence: 'medium',
  };
};

// ── Disk full ───────────────────────────────────────────────────────────────────────────────

const diskFull: Playbook = (e) => {
  const msg = line(e, /ENOSPC|No space left on device|disk full|could not extend file/i);
  if (!msg) return null;
  return {
    id: 'disk-full',
    title: 'The disk is full',
    cause: 'The app cannot write files (logs, uploads, database pages, caches) because there is no space left — and a half-written file can keep breaking it after space is freed.',
    evidence: [quote(msg)],
    fixNow: ['Free space: `docker system df`, `docker image prune -a`, and check for large logs (`du -xh / | sort -h | tail`). Then restart the app and check its caches aren\'t left empty.'],
    permanentFix: 'Cap Docker log size (`"log-opts": {"max-size": "50m", "max-file": "3"}` in /etc/docker/daemon.json), rotate app logs, and keep uploads in object storage.',
    restartHelps: false,
    confidence: 'high',
  };
};

/** In order of how specific they are: the first match is the best explanation. */
export const playbooks: Playbook[] = [
  laravelEmptyCache,
  wrongArchitecture,
  brokenEntrypoint,
  outOfMemory,
  diskFull,
  prisma,
  missingEnv,
  databaseUnreachable,
  portInUse,
  nextNoBuild,
  missingModule,
  permissionDenied,
];

export function runPlaybooks(e: Evidence): Finding[] {
  const out: Finding[] = [];
  for (const pb of playbooks) {
    try {
      const f = pb(e);
      if (f) out.push(f);
    } catch {
      // A playbook bug must never stop the investigation.
    }
  }
  return out;
}
