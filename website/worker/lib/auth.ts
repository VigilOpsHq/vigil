// Session and server-token authentication.
//
// Licensed under FSL-1.1-MIT (see website/LICENSE.md): use and self-host freely,
// but not as a competing product or service. Converts to MIT after two years.
import type { Env } from './env';
import { HttpError, cookie, isSecure, parseCookies } from './http';
import { randomToken, sha256Hex } from './crypto';

export const SESSION_COOKIE = 'vo_session';
const SESSION_DAYS = 30;

export interface Account {
  id: string;
  login: string | null;
  name: string | null;
  email: string;
  emails: string[];
  telegram_chat_id: string | null;
}

interface AccountRow extends Omit<Account, 'emails'> {
  emails: string;
}

export function requireDb(env: Env) {
  if (!env.DB) throw new HttpError(503, 'VigilOps Cloud is not configured (missing DB binding)');
  return env.DB;
}

export async function createSession(env: Env, request: Request, accountId: string): Promise<string> {
  const db = requireDb(env);
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await db
    .prepare('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(token), accountId, expires)
    .run();
  return cookie(SESSION_COOKIE, token, SESSION_DAYS * 86400, isSecure(request));
}

export async function destroySession(env: Env, request: Request): Promise<string> {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (token && env.DB) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  }
  return cookie(SESSION_COOKIE, '', 0, isSecure(request));
}

export async function getAccount(env: Env, request: Request): Promise<Account | null> {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token || !env.DB) return null;
  const row = await env.DB.prepare(
    `SELECT a.id, a.login, a.name, a.email, a.emails, a.telegram_chat_id
     FROM sessions s JOIN accounts a ON a.id = s.account_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  )
    .bind(await sha256Hex(token), new Date().toISOString())
    .first<AccountRow>();
  if (!row) return null;
  return { ...row, emails: JSON.parse(row.emails || '[]') };
}

export async function requireAccount(env: Env, request: Request): Promise<Account> {
  const account = await getAccount(env, request);
  if (!account) throw new HttpError(401, 'Sign in required');
  return account;
}
