import { ContainerStatus } from '../types';

/**
 * A stopped container nobody asked Docker to keep running: no restart policy, or `on-failure`
 * that exited cleanly. These are one-off jobs (build steps left behind by `docker run` without
 * `--rm`, migrations, scripts). Restarting one reruns the job, and it stops again a moment
 * later — a restart every few minutes, forever. Unknown policy (inspect failed) is not one-off.
 */
export function isOneOffJob(c: ContainerStatus): boolean {
  if (c.restartPolicy === undefined) return false;
  if (c.restartPolicy === 'no') return true;
  return c.restartPolicy === 'on-failure' && c.exitCode === 0;
}
