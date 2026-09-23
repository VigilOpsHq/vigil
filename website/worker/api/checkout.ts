// POST /api/checkout
// Creates a Bachs checkout session for a paid plan and returns its URL.
// The secret key stays on the server; the browser only gets checkout_url.
//
// Licensed under FSL-1.1-MIT (see website/LICENSE.md): use and self-host freely,
// but not as a competing product or service. Converts to MIT after two years.

import type { RequestContext } from '../lib/env';
import { HttpError, json, readJson } from '../lib/http';
import { getAccount } from '../lib/auth';

const PLANS = ['pro', 'team'];
const INTERVALS = ['monthly', 'yearly'];

export async function checkout({ request, env }: RequestContext): Promise<Response> {
  const input = await readJson<{ plan?: string; interval?: string; email?: string; name?: string }>(request);

  const plan = String(input.plan ?? '');
  const interval = String(input.interval ?? '');
  const email = String(input.email ?? '').trim().slice(0, 254);
  const name = String(input.name ?? '').trim().slice(0, 100);

  if (!PLANS.includes(plan) || !INTERVALS.includes(interval)) throw new HttpError(400, 'Unknown plan.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name) throw new HttpError(400, 'Enter a valid name and email.');

  const productId = env[`BACHS_PRODUCT_${plan.toUpperCase()}_${interval.toUpperCase()}`] as string | undefined;
  if (!env.BACHS_API_KEY || !productId) {
    console.error(`checkout not configured: key=${Boolean(env.BACHS_API_KEY)} product=${Boolean(productId)} plan=${plan} interval=${interval}`);
    throw new HttpError(503, 'Checkout is not available right now.');
  }

  // Link the subscription to the signed-in account, if any, so the plan unlocks even if the emails differ
  const account = await getAccount(env, request).catch(() => null);

  const origin = new URL(request.url).origin;
  const base = (env.BACHS_API_BASE || 'https://sandbox-api.bachs.io').replace(/\/+$/, '');
  const res = await fetch(`${base}/v1/checkout-sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.BACHS_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      product_cart: [{ product_id: productId, quantity: 1 }],
      customer: { email, name },
      success_url: `${origin}/checkout/success/`,
      cancel_url: `${origin}/pricing/`,
      metadata: { plan, interval, source: 'vigilops.cloud', ...(account ? { account_id: account.id } : {}) },
      expires_in_minutes: 60,
    }),
  });

  const body = (await res.json().catch(() => null)) as { checkout_url?: string } | null;
  if (!res.ok || !body?.checkout_url) {
    console.error(`bachs checkout failed: ${res.status} ${JSON.stringify(body)}`);
    throw new HttpError(502, 'Checkout is not available right now.');
  }

  return json({ checkout_url: body.checkout_url });
}
