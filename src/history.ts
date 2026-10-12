import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { error } from './logger';

const HISTORY_FILE = path.join(process.env.BACKUP_DIR ?? '/var/backups/vigil', 'history.json');
const KEEP = 50;

export type Reversible =
  | { type: 'deploy'; app: string; image: string; previousImageId: string; composePath: string; service: string }
  | { type: 'restore'; container: string; database: string; safetyBackup: string };

export interface HistoryEntry {
  id: string;
  at: string;
  undone?: string;
  what: Reversible;
}

function read(): HistoryEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(entries: HistoryEntry[]): void {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(entries.slice(-KEEP), null, 2));
  } catch (err) {
    error('[history] Could not write history', err);
  }
}

export function record(what: Reversible): void {
  const entries = read();
  entries.push({ id: crypto.randomBytes(3).toString('hex'), at: new Date().toISOString(), what });
  write(entries);
}

/** The most recent action that can still be reversed. */
export function lastReversible(): HistoryEntry | null {
  const entries = read();
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!entries[i].undone) return entries[i];
  }
  return null;
}

export function markUndone(id: string): void {
  const entries = read();
  const entry = entries.find((e) => e.id === id);
  if (entry) {
    entry.undone = new Date().toISOString();
    write(entries);
  }
}

export function describe(entry: HistoryEntry): string {
  const when = new Date(entry.at);
  const mins = Math.round((Date.now() - when.getTime()) / 60_000);
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)}h ago`;

  if (entry.what.type === 'deploy') {
    return `deploy of ${entry.what.app} (${ago}) — would put back the image it replaced`;
  }
  return `restore of ${entry.what.database} in ${entry.what.container} (${ago}) — would put back the safety backup taken first`;
}
