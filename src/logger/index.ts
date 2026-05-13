import fs from 'fs';
import path from 'path';
import { AuditEntry } from '../types';

const LOG_PATH = path.resolve(process.cwd(), 'logs', 'audit.jsonl');

const logsDir = path.dirname(LOG_PATH);
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

export function log(entry: Omit<AuditEntry, 'timestamp'>): void {
  const record: AuditEntry = {
    timestamp: new Date().toISOString(),
    ...entry,
  };

  const line = JSON.stringify(record) + '\n';
  fs.appendFileSync(LOG_PATH, line, 'utf8');
  console.log(`[${record.timestamp}] [${record.trigger.toUpperCase()}] ${record.message}`);
}

export function info(message: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [INFO] ${message}`);
}

export function error(message: string, err?: unknown): void {
  const ts = new Date().toISOString();
  const detail = err instanceof Error ? err.message : String(err ?? '');
  console.error(`[${ts}] [ERROR] ${message}${detail ? ` — ${detail}` : ''}`);
}
