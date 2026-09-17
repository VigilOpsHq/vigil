// Cloudflare Worker entry: serves the built site from ./dist and handles the API routes.
import { onRequestPost as checkout } from './api/checkout';
import { onRequestPost as bachsWebhook } from './api/bachs-webhook';

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  [key: string]: any;
}

const routes: Record<string, (ctx: { request: Request; env: any }) => Promise<Response>> = {
  '/api/checkout': checkout,
  '/api/bachs-webhook': bachsWebhook,
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const handler = routes[pathname];

    if (handler) {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
      }
      return handler({ request, env });
    }

    return env.ASSETS.fetch(request);
  },
};
