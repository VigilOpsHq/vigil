// POST /api/checkout (routed from worker/index.ts)
// Creates a Bachs checkout session for a paid plan and returns its URL.
// The secret key stays here on the server; the browser only gets checkout_url.

interface Env {
  BACHS_API_KEY?: string;
  BACHS_API_BASE?: string;
  [productVar: string]: string | undefined;
}

interface Context {
  request: Request;
  env: Env;
}

const PLANS = ['pro', 'team'] as const;
const INTERVALS = ['monthly', 'yearly'] as const;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export const onRequestPost = async ({ request, env }: Context): Promise<Response> => {
  let input: { plan?: string; interval?: string; email?: string; name?: string };
  try {
    input = await request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  const plan = String(input.plan ?? '');
  const interval = String(input.interval ?? '');
  const email = String(input.email ?? '').trim().slice(0, 254);
  const name = String(input.name ?? '').trim().slice(0, 100);

  if (!PLANS.includes(plan as (typeof PLANS)[number]) || !INTERVALS.includes(interval as (typeof INTERVALS)[number])) {
    return json({ error: 'Unknown plan.' }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name) {
    return json({ error: 'Enter a valid name and email.' }, 400);
  }

  const productId = env[`BACHS_PRODUCT_${plan.toUpperCase()}_${interval.toUpperCase()}`];
  if (!env.BACHS_API_KEY || !productId) {
    console.error(`checkout not configured: key=${Boolean(env.BACHS_API_KEY)} product=${Boolean(productId)} plan=${plan} interval=${interval}`);
    return json({ error: 'Checkout is not available right now.' }, 503);
  }

  const origin = new URL(request.url).origin;
  const base = (env.BACHS_API_BASE || 'https://sandbox-api.bachs.io').replace(/\/+$/, '');

  const res = await fetch(`${base}/v1/checkout-sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.BACHS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      product_cart: [{ product_id: productId, quantity: 1 }],
      customer: { email, name },
      success_url: `${origin}/checkout/success/`,
      cancel_url: `${origin}/pricing/`,
      metadata: { plan, interval, source: 'vigilops.cloud' },
      expires_in_minutes: 60,
    }),
  });

  const body = (await res.json().catch(() => null)) as { checkout_url?: string } | null;
  if (!res.ok || !body?.checkout_url) {
    console.error(`bachs checkout failed: ${res.status} ${JSON.stringify(body)}`);
    return json({ error: 'Checkout is not available right now.' }, 502);
  }

  return json({ checkout_url: body.checkout_url });
};
