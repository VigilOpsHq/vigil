/**
 * Reading a crash log the way a person would: skip the stack frames, find where the latest start
 * begins, and take the first error after it. In a restart loop the last error printed is rarely
 * the cause — Laravel's "Target class [config] does not exist" hid an empty cache file for days.
 */

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s?/;

/** Stack frames and trace furniture: they repeat inside one crash, so they can't mark a new start. */
const STACK_LINE = [
  /^#\d+\s/,                         // PHP
  /^\s+at\s/,                        // Node, Java
  /^\s+File\s+"/,                    // Python
  /^\s*Stack trace:?$/i,
  /^\s*Traceback \(most recent call last\):?$/,
  /^\s*\{main\}$/,
  /^\s*thrown in\s/,
  /^\s*\.\.\. \d+ more$/,
  /^\s*node:internal\//,
  /^\s*\^+\s*$/,
];

const ERROR_LINE = /\b(error|exception|fatal|panic|traceback|failed|failure|refused|denied|cannot|can't|could not|couldn't|unable|not found|no such file|segmentation fault|killed|ENOENT|EACCES|EADDRINUSE|ECONNREFUSED|ENOTFOUND|ENOSPC|SQLSTATE|P\d{4})\b/i;
/** Class-style names: TypeError, BindingResolutionException, PDOException, MissingAppKeyException… */
const ERROR_CLASS = /[A-Za-z0-9_]+(?:Error|Exception)\b|\bdoes not exist\b/;
const NOT_AN_ERROR =/\b(0 errors?|no errors?|errors?: 0|error_reporting|without errors?|debug|INFO\b.*\bsuccess)/i;

export function stripTimestamp(line: string): string {
  return line.replace(TIMESTAMP, '');
}

export function isStackLine(line: string): boolean {
  return STACK_LINE.some((re) => re.test(line));
}

export function isErrorLine(line: string): boolean {
  return (ERROR_LINE.test(line) || ERROR_CLASS.test(line)) && !NOT_AN_ERROR.test(line) && !isStackLine(line);
}

/** Numbers, ids and times change between restarts; the message doesn't. */
function signature(line: string): string {
  return line.trim()
    .replace(TIMESTAMP, '')
    .replace(/\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<t>')
    .replace(/\b(?:pid|PID)[ =:]?\d+/g, '<pid>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\b\d+\b/g, '<n>');
}

/**
 * The lines of one complete start in a restart loop, or the whole tail when the log doesn't loop.
 *
 * A loop prints the same sequence again and again, so the end of the log is periodic: find the
 * shortest period, then line it up so it begins after the errors (at the startup banner, like
 * "==> Caching config...") rather than in the middle of them. The log usually ends part-way
 * through a new start, so the cycle returned is the last complete one.
 */
export function latestCycle(lines: string[]): string[] {
  const idx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() && !isStackLine(lines[i])) idx.push(i);
  }
  const sig = idx.map((i) => signature(lines[i]));
  const err = idx.map((i) => isErrorLine(lines[i]));
  const n = idx.length;

  for (let p = 1; p <= Math.min(200, Math.floor(n / 2)); p++) {
    const need = Math.max(p, 4);
    if (n < p + need) break;
    let periodic = true;
    for (let k = 0; k < need && periodic; k++) periodic = sig[n - 1 - k] === sig[n - 1 - k - p];
    if (!periodic) continue;
    const window = Array.from({ length: p }, (_, k) => n - p + k);
    if (!window.some((w) => err[w])) continue; // a repeated retry line, not a crash loop

    // First line of the cycle: an ordinary line right after an error line.
    let r = window.findIndex((w, k) => !err[w] && err[window[(k - 1 + p) % p]]);
    if (r < 0) r = 0;
    if (r === 0) return lines.slice(idx[n - p]);
    if (n - 2 * p + r < 0) return lines.slice(idx[n - p]);
    return lines.slice(idx[n - 2 * p + r], idx[n - p + r]);
  }
  return lines;
}

/** Distinct error lines in order of first appearance, stack frames left out. */
export function distinctErrors(lines: string[], max = 8): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || !isErrorLine(line)) continue;
    const sig = signature(line);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(line.length > 400 ? `${line.slice(0, 400)}…` : line);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * `docker logs --timestamps` prints stdout and stderr separately; merging them by timestamp
 * puts each error back next to what the app was doing when it happened.
 */
export function mergeStreams(stdout: string, stderr: string): string[] {
  const lines = [...stdout.split('\n'), ...stderr.split('\n')].filter((l) => l.length > 0);
  const stamp = (l: string) => TIMESTAMP.exec(l)?.[0] ?? '';
  return lines
    .map((l, i) => ({ l, i, t: stamp(l) }))
    .sort((a, b) => (a.t && b.t && a.t !== b.t ? (a.t < b.t ? -1 : 1) : a.i - b.i))
    .map(({ l }) => stripTimestamp(l));
}

const SECRET_PATTERNS: [RegExp, string][] = [
  // scheme://user:password@host
  [/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s]+@/gi, '$1***@'],
  // Authorization headers and bearer tokens
  [/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 ***'],
  // KEY=value / "key": "value" for secret-sounding names
  [/((?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth|credential|dsn)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1***'],
  // Well-known token shapes
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}\b/g, '***'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '***'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, '***'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '***'],
  // Laravel APP_KEY style
  [/\bbase64:[A-Za-z0-9+/]{32,}={0,2}/g, 'base64:***'],
];

/** Logs travel to Telegram, the AI provider and the user's editor: take the secrets out first. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((t, [re, to]) => t.replace(re, to), text);
}
