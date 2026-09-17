// Cloudflare Worker entry: VigilOps website, dashboard API, agent API, webhooks and scheduled checks.
import type { Env, RequestContext } from './lib/env';
import { HttpError, assertSameOrigin, json } from './lib/http';
import { checkout } from './api/checkout';
import { bachsWebhook } from './api/bachs-webhook';
import { devLogin, githubCallback, githubStart, logout, me } from './api/auth';
import * as app from './api/app';
import * as agent from './api/agent';
import { telegramWebhook } from './api/telegram';
import { runScheduled } from './cron';

type Handler = (ctx: RequestContext) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  /** Cookie-authenticated state changes: reject cross-site requests */
  sameOrigin?: boolean;
}

function route(method: string, path: string, handler: Handler, sameOrigin = false): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$'
  );
  return { method, pattern, keys, handler, sameOrigin };
}

const routes: Route[] = [
  route('POST', '/api/checkout', checkout, true),
  route('POST', '/api/bachs-webhook', bachsWebhook),
  route('POST', '/api/telegram/webhook', telegramWebhook),

  route('GET', '/auth/github', githubStart),
  route('GET', '/auth/github/callback', githubCallback),
  route('GET', '/auth/dev', devLogin),
  route('POST', '/auth/logout', logout, true),
  route('GET', '/api/me', me),

  route('GET', '/api/app/overview', app.overview),
  route('POST', '/api/app/servers', app.createServer, true),
  route('POST', '/api/app/servers/:id/token', app.rotateServerToken, true),
  route('DELETE', '/api/app/servers/:id', app.deleteServer, true),
  route('GET', '/api/app/servers/:id/backups', app.listBackups),
  route('GET', '/api/app/backups/:id/download', app.downloadBackup),
  route('DELETE', '/api/app/backups/:id', app.deleteBackup, true),
  route('POST', '/api/app/telegram/link', app.telegramLink, true),
  route('POST', '/api/app/telegram/unlink', app.telegramUnlink, true),
  route('POST', '/api/app/billing-portal', app.billingPortal, true),

  route('POST', '/api/agent/heartbeat', agent.heartbeat),
  route('POST', '/api/agent/backups', agent.startUpload),
  route('GET', '/api/agent/backups', agent.agentListBackups),
  route('PUT', '/api/agent/backups/:id/parts/:part', agent.uploadPart),
  route('POST', '/api/agent/backups/:id/complete', agent.completeUpload),
  route('POST', '/api/agent/backups/:id/abort', agent.abortUpload),
  route('GET', '/api/agent/backups/file/:file', agent.agentDownload),
];

const isDynamic = (path: string) => path.startsWith('/api/') || path.startsWith('/auth/');

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }

    if (!isDynamic(url.pathname)) return env.ASSETS.fetch(request);

    const matches = routes.filter((r) => r.pattern.test(url.pathname));
    if (matches.length === 0) return json({ error: 'Not found' }, 404);
    const r = matches.find((m) => m.method === request.method);
    if (!r) return json({ error: 'Method not allowed' }, 405, { Allow: matches.map((m) => m.method).join(', ') });

    const found = url.pathname.match(r.pattern)!;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(found[i + 1])]));

    try {
      if (r.sameOrigin) assertSameOrigin(request);
      return await r.handler({ request, env, params, waitUntil: (p) => ctx.waitUntil(p) });
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(`${request.method} ${url.pathname} failed`, err);
      return json({ error: 'Something went wrong' }, 500);
    }
  },

  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    ctx.waitUntil(runScheduled(env));
  },
};
