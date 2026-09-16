import fs from 'fs';
import os from 'os';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { error } from '../logger';

const TELEGRAM_LIMIT_BYTES = 50 * 1024 * 1024;

function telegramConfig(): { token: string; chatId: string } | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  return token && chatId ? { token, chatId } : null;
}

function s3Config() {
  const bucket = process.env.BACKUP_S3_BUCKET;
  const accessKeyId = process.env.BACKUP_S3_ACCESS_KEY;
  const secretAccessKey = process.env.BACKUP_S3_SECRET_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) return null;

  const client = new S3Client({
    endpoint: process.env.BACKUP_S3_ENDPOINT || undefined,
    region: process.env.BACKUP_S3_REGION || 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  const prefix = (process.env.BACKUP_S3_PREFIX || `vigil/${os.hostname()}`).replace(/\/+$/, '');
  return { client, bucket, prefix };
}

// Uses the HTTP API directly so the CLI can notify without starting a second bot poller
export async function notifyText(text: string): Promise<void> {
  const tg = telegramConfig();
  if (!tg) return;
  try {
    await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tg.chatId, text }),
    });
  } catch (err) {
    error('[backup] Telegram message failed', err);
  }
}

async function sendToTelegram(filePath: string, fileName: string): Promise<boolean> {
  const tg = telegramConfig();
  if (!tg) return false;
  const form = new FormData();
  form.append('chat_id', tg.chatId);
  form.append('document', new Blob([await fs.promises.readFile(filePath)]), fileName);
  const res = await fetch(`https://api.telegram.org/bot${tg.token}/sendDocument`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Telegram upload failed: ${res.status} ${await res.text()}`);
  return true;
}

export async function deliverOffsite(filePath: string, fileName: string, sizeBytes: number): Promise<string[]> {
  const delivered: string[] = [];

  const s3 = s3Config();
  if (s3) {
    try {
      await s3.client.send(new PutObjectCommand({
        Bucket: s3.bucket,
        Key: `${s3.prefix}/${fileName}`,
        Body: fs.createReadStream(filePath),
        ContentLength: sizeBytes,
      }));
      delivered.push(`storage (${s3.bucket})`);
    } catch (err) {
      error('[backup] Upload to storage failed', err);
    }
  }

  if (process.env.BACKUP_SEND_TO_TELEGRAM !== 'false' && sizeBytes <= TELEGRAM_LIMIT_BYTES) {
    try {
      if (await sendToTelegram(filePath, fileName)) delivered.push('Telegram');
    } catch (err) {
      error('[backup] Sending backup to Telegram failed', err);
    }
  }

  return delivered;
}

export async function fetchFromStorage(fileName: string, destPath: string): Promise<boolean> {
  const s3 = s3Config();
  if (!s3) return false;
  try {
    const res = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: `${s3.prefix}/${fileName}` }));
    if (!res.Body) return false;
    await pipeline(res.Body as Readable, fs.createWriteStream(destPath));
    return true;
  } catch (err) {
    fs.rmSync(destPath, { force: true });
    error('[backup] Download from storage failed', err);
    return false;
  }
}
