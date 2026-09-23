// Sign-in: GitHub OAuth, sessions, and the current account.
//
// Licensed under FSL-1.1-MIT (see website/LICENSE.md): use and self-host freely,
// but not as a competing product or service. Converts to MIT after two years.
import type { RequestContext } from '../lib/env';
import { HttpError, cookie, isSecure, json, parseCookies } from '../lib/http';
import { newId, randomToken } from '../lib/crypto';
import { createSession, destroySession, getAccount, requireDb } from '../lib/auth';
import { entitlementFor } from '../lib/plans';

const STATE_COOKIE = 'vo_oauth_state';

function safeNext(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/app/';
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  cookies.forEach((c) => headers.append('Set-Cookie', c));
  return new Response(null, { status: 302, headers });
}

// GET /auth/github?next=/app/
export async function githubStart({ request, env }: RequestContext): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID) throw new HttpError(503, 'GitHub sign-in is not configured');
  const url = new URL(request.url);
  const state = randomToken(24);
  const next = safeNext(url.searchParams.get('next'));

  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', `${url.origin}/auth/github/callback`);
  authorize.searchParams.set('scope', 'read:user user:email');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('allow_signup', 'true');

  return redirect(authorize.toString(), [cookie(STATE_COOKIE, `${state}|${next}`, 600, isSecure(request))]);
}

interface GithubUser {
  id: number;
  login: string;
  name: string | null;
}
interface GithubEmail {
  email: string;
  verified: boolean;
  primary: boolean;
}

async function github<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'vigilops-cloud' },
  });
  if (!res.ok) throw new HttpError(502, `GitHub API error ${res.status}`);
  return res.json() as Promise<T>;
}

// GET /auth/github/callback
export async function githubCallback({ request, env }: RequestContext): Promise<Response> {
  const db = requireDb(env);
  const url = new URL(request.url);
  const [savedState, next] = (parseCookies(request)[STATE_COOKIE] ?? '').split('|');
  const clearState = cookie(STATE_COOKIE, '', 0, isSecure(request));

  if (!savedState || savedState !== url.searchParams.get('state') || !url.searchParams.get('code')) {
    return redirect('/login/?error=state', [clearState]);
  }

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code: url.searchParams.get('code'),
      redirect_uri: `${url.origin}/auth/github/callback`,
    }),
  });
  const tokenBody = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
  if (!tokenBody.access_token) return redirect('/login/?error=github', [clearState]);

  const user = await github<GithubUser>('/user', tokenBody.access_token);
  const emails = await github<GithubEmail[]>('/user/emails', tokenBody.access_token);
  const verified = emails.filter((e) => e.verified).map((e) => e.email.toLowerCase());
  const primary = emails.find((e) => e.primary && e.verified)?.email.toLowerCase() ?? verified[0];
  if (!primary) return redirect('/login/?error=email', [clearState]);

  const existing = await db.prepare('SELECT id FROM accounts WHERE github_id = ?').bind(user.id).first<{ id: string }>();
  const accountId = existing?.id ?? newId('acct');
  if (existing) {
    await db
      .prepare('UPDATE accounts SET login = ?, name = ?, email = ?, emails = ? WHERE id = ?')
      .bind(user.login, user.name, primary, JSON.stringify(verified), accountId)
      .run();
  } else {
    await db
      .prepare('INSERT INTO accounts (id, github_id, login, name, email, emails) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(accountId, user.id, user.login, user.name, primary, JSON.stringify(verified))
      .run();
  }

  // Claim subscriptions bought with any of this account's verified emails
  const placeholders = verified.map(() => '?').join(',');
  await db
    .prepare(`UPDATE subscriptions SET account_id = ? WHERE account_id IS NULL AND email IN (${placeholders})`)
    .bind(accountId, ...verified)
    .run();

  return redirect(safeNext(next ?? null), [clearState, await createSession(env, request, accountId)]);
}

// GET /auth/dev?email=you@example.com  (local development only)
export async function devLogin({ request, env }: RequestContext): Promise<Response> {
  if (env.DEV_LOGIN !== 'true') throw new HttpError(404, 'Not found');
  const db = requireDb(env);
  const email = (new URL(request.url).searchParams.get('email') ?? 'dev@example.com').toLowerCase();
  let row = await db.prepare('SELECT id FROM accounts WHERE email = ?').bind(email).first<{ id: string }>();
  if (!row) {
    row = { id: newId('acct') };
    await db
      .prepare('INSERT INTO accounts (id, login, name, email, emails) VALUES (?, ?, ?, ?, ?)')
      .bind(row.id, email.split('@')[0], 'Dev User', email, JSON.stringify([email]))
      .run();
  }
  return redirect('/app/', [await createSession(env, request, row.id)]);
}

// POST /auth/logout
export async function logout({ request, env }: RequestContext): Promise<Response> {
  return redirect('/', [await destroySession(env, request)]);
}

// GET /api/me
export async function me({ request, env }: RequestContext): Promise<Response> {
  const account = await getAccount(env, request);
  if (!account) return json({ signedIn: false }, 401);
  const ent = await entitlementFor(requireDb(env), account);
  return json({
    signedIn: true,
    account: {
      id: account.id,
      login: account.login,
      name: account.name,
      email: account.email,
      emails: account.emails,
      telegramConnected: Boolean(account.telegram_chat_id),
    },
    plan: ent.plan,
    status: ent.status,
    limits: ent.limits,
    currentPeriodEnd: ent.currentPeriodEnd,
    cancelAtPeriodEnd: ent.cancelAtPeriodEnd,
    githubConfigured: Boolean(env.GITHUB_CLIENT_ID),
  });
}
