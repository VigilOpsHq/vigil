/**
 * Short-term memory for the watch loop: what already failed, what already ran, and what the
 * operator was already told. Without it every poll (60s) repeats the same fix and the same
 * message for as long as a problem lasts — 26 failed `systemctl restart nginx` runs on one
 * server, and a Telegram alert every minute.
 *
 * In-process only, so a restart of Vigil forgets it. That is fine: the worst case after a
 * restart is one repeat.
 */

const minutes = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return (Number.isFinite(n) && n > 0 ? n : fallback) * 60_000;
};

/** A command that failed is not tried again for this long. */
export const FAILED_COMMAND_COOLDOWN_MS = minutes('FAILED_COMMAND_COOLDOWN_MINUTES', 360);
/** The same alert is not sent again for this long while the problem lasts. */
export const ALERT_COOLDOWN_MS = minutes('ALERT_COOLDOWN_MINUTES', 60);
/** The same unexplained problem is not sent to the AI again for this long. */
export const ESCALATION_COOLDOWN_MS = minutes('ESCALATION_COOLDOWN_MINUTES', 30);
/** A clean-up that worked (prune) is not run again for this long, even if the disk stays full. */
export const SUCCESS_COOLDOWN_MS = minutes('REPEAT_FIX_COOLDOWN_MINUTES', 60);

const failedAt = new Map<string, number>();
const succeededAt = new Map<string, number>();
const alertedAt = new Map<string, number>();

export function recordResult(command: string, ok: boolean, now = Date.now()): void {
  if (ok) {
    failedAt.delete(command);
    succeededAt.set(command, now);
  } else {
    failedAt.set(command, now);
  }
}

export function recentlyFailed(command: string, now = Date.now()): boolean {
  const at = failedAt.get(command);
  return at !== undefined && now - at < FAILED_COMMAND_COOLDOWN_MS;
}

/**
 * True when this command just worked and repeating it would only repeat the same result.
 * `docker restart` is exempt: restarts have their own crash-loop accounting.
 */
export function recentlySucceeded(command: string, now = Date.now()): boolean {
  if (/^docker restart /.test(command)) return false;
  const at = succeededAt.get(command);
  return at !== undefined && now - at < SUCCESS_COOLDOWN_MS;
}

/** True the first time a key is seen, then false until the cooldown passes. */
export function shouldAlert(key: string, cooldownMs = ALERT_COOLDOWN_MS, now = Date.now()): boolean {
  const at = alertedAt.get(key);
  if (at !== undefined && now - at < cooldownMs) return false;
  alertedAt.set(key, now);
  return true;
}

/** Forget every open alert — called when the server is healthy again. Returns how many there were. */
export function clearAlerts(): number {
  const n = alertedAt.size;
  alertedAt.clear();
  return n;
}

export function hasOpenAlerts(): boolean {
  return alertedAt.size > 0;
}

/** Test hook. */
export function resetMemory(): void {
  failedAt.clear();
  succeededAt.clear();
  alertedAt.clear();
}
