import { exec } from 'child_process';
import { promisify } from 'util';
import { HistoryEntry, lastReversible, markUndone } from './history';
import { restore } from './backup/engine';
import { log, info } from './logger';

const execAsync = promisify(exec);
const run = (cmd: string) => execAsync(cmd, { timeout: 180_000 });

export interface UndoResult {
  what: string;
  detail: string;
}

export { lastReversible, describe } from './history';

export async function undo(entry: HistoryEntry): Promise<UndoResult> {
  if (entry.what.type === 'deploy') {
    const { app, image, previousImageId, composePath, service } = entry.what;
    info(`[undo] Putting ${app} back on ${previousImageId.slice(0, 19)}`);

    await run(`docker tag ${previousImageId} ${image}:latest`);
    await run(`docker compose -f ${composePath} up -d --no-build --pull=never ${service}`);

    markUndone(entry.id);
    log({
      trigger: 'manual',
      action: `undo deploy ${app}`,
      result: 'success',
      message: `${app} put back on the image it ran before the last deploy`,
    });
    return { what: `${app} rolled back`, detail: `now running ${previousImageId.slice(0, 19)}` };
  }

  const { container, database, safetyBackup } = entry.what;
  info(`[undo] Restoring ${safetyBackup} into ${container}`);

  // restore() takes its own safety backup first, so this is itself reversible
  const { safetyBackup: newSafety } = await restore(safetyBackup, container, database);

  markUndone(entry.id);
  log({
    trigger: 'manual',
    action: `undo restore ${container}`,
    result: 'success',
    message: `${database} in ${container} put back to the state before the last restore`,
  });
  return {
    what: `${database} in ${container} rolled back`,
    detail: `the state it was in before that restore; this undo saved ${newSafety}`,
  };
}
