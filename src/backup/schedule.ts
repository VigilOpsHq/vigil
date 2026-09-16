import fs from 'fs';
import path from 'path';
import { BACKUP_DIR, backupAndNotify } from './engine';
import { info, error } from '../logger';

export interface BackupSchedule {
  container: string;
  database?: string;
  every: 'hourly' | 'daily' | 'weekly';
  time: string; // HH:MM (hourly uses only the minutes)
  day?: number; // 0 = Sunday, weekly only
  lastRun: string; // ISO
}

const SCHEDULE_FILE = path.join(BACKUP_DIR, 'schedules.json');
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function loadSchedules(): BackupSchedule[] {
  try {
    return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveSchedules(schedules: BackupSchedule[]): void {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedules, null, 2));
}

/**
 * Accepts: "hourly" | "daily [HH:MM]" | "weekly [day] [HH:MM]"
 */
export function setSchedule(container: string, spec: string[], database?: string): BackupSchedule {
  const [every, ...rest] = spec.map((s) => s.toLowerCase());
  const timeArg = rest.find((r) => /^\d{1,2}:\d{2}$/.test(r));
  const dayArg = rest.find((r) => DAYS.includes(r.slice(0, 3)));

  if (every !== 'hourly' && every !== 'daily' && every !== 'weekly') {
    throw new Error('Schedule must be: hourly | daily [HH:MM] | weekly [day] [HH:MM]');
  }
  const [h, m] = (timeArg ?? '02:00').split(':').map(Number);
  if (h > 23 || m > 59) throw new Error(`Invalid time "${timeArg}"`);

  const schedule: BackupSchedule = {
    container,
    database,
    every,
    time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
    day: every === 'weekly' ? (dayArg ? DAYS.indexOf(dayArg.slice(0, 3)) : 0) : undefined,
    lastRun: new Date().toISOString(),
  };

  const schedules = loadSchedules().filter((s) => s.container !== container);
  schedules.push(schedule);
  saveSchedules(schedules);
  return schedule;
}

export function removeSchedule(container: string): boolean {
  const schedules = loadSchedules();
  const kept = schedules.filter((s) => s.container !== container);
  saveSchedules(kept);
  return kept.length !== schedules.length;
}

export function describeSchedule(s: BackupSchedule): string {
  if (s.every === 'hourly') return `every hour at :${s.time.split(':')[1]}`;
  if (s.every === 'daily') return `every day at ${s.time}`;
  return `every ${DAYS[s.day ?? 0]} at ${s.time}`;
}

function lastSlot(s: BackupSchedule, now: Date): Date {
  const [h, m] = s.time.split(':').map(Number);
  const slot = new Date(now);
  slot.setSeconds(0, 0);

  if (s.every === 'hourly') {
    slot.setMinutes(m);
    if (slot > now) slot.setHours(slot.getHours() - 1);
    return slot;
  }

  slot.setHours(h, m);
  if (s.every === 'daily') {
    if (slot > now) slot.setDate(slot.getDate() - 1);
    return slot;
  }

  slot.setDate(slot.getDate() - ((slot.getDay() - (s.day ?? 0) + 7) % 7));
  if (slot > now) slot.setDate(slot.getDate() - 7);
  return slot;
}

let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    for (const s of loadSchedules()) {
      if (new Date(s.lastRun) >= lastSlot(s, now)) continue;

      // Record the run first so a failing backup doesn't retry every minute
      const all = loadSchedules();
      const entry = all.find((x) => x.container === s.container);
      if (entry) {
        entry.lastRun = now.toISOString();
        saveSchedules(all);
      }

      info(`[backup] Scheduled backup starting: ${s.container}`);
      await backupAndNotify(s.container, s.database).catch((err) =>
        error(`[backup] Scheduled backup failed: ${s.container}`, err)
      );
    }
  } finally {
    running = false;
  }
}

export function startBackupScheduler(): void {
  const count = loadSchedules().length;
  info(`[backup] Scheduler started — ${count} schedule(s) in ${SCHEDULE_FILE}`);
  setInterval(() => { tick().catch((err) => error('[backup] Scheduler tick failed', err)); }, 60 * 1000);
}
