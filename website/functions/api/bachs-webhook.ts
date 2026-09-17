// Cloudflare Pages Function: POST /api/bachs-webhook
// Receives Bachs events, verifies the signature, and tells the team on Telegram.
// Until VigilOps Cloud has a backend, fulfilment is manual: this notification is the trigger.

interface Env {
  BACHS_WEBHOOK_SECRET?: string;
  SALES_TELEGRAM_BOT_TOKEN?: string;
  SALES_TELEGRAM_CHAT_ID?: string;
  SALES_EVENTS?: { put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> };
}

interface Context {
  request: Request;
  env: Env;
}

interface BachsEvent {
  id: string;
  type: string;
  created_at?: string;
  data?: Record<string, any>;
}

const TOLERANCE_SECONDS = 300;
const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verify(request: Request, raw: string, secret: string): Promise<boolean> {
  let timestamp: string | null = null;
  let signatures: string[] = [];

  const v2 = request.headers.get('X-Bachs-Signature-V2');
  if (v2) {
    for (const part of v2.split(',')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k === 't') timestamp = v;
      if (k === 'v1') signatures.push(v);
    }
  } else {
    timestamp = request.headers.get('X-Bachs-Timestamp');
    const v1 = request.headers.get('X-Bachs-Signature');
    if (v1) signatures = [v1];
  }

  if (!timestamp || signatures.length === 0) return false;
  const t = Number(timestamp);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > TOLERANCE_SECONDS) return false;

  const expected = await hmacHex(secret, `${timestamp}.${raw}`);
  return signatures.some((s) => safeEqual(expected, s));
}

function describe(event: BachsEvent): string | null {
  const d = event.data ?? {};
  const who = d.customer?.email ?? d.customer_details?.email ?? 'unknown customer';
  const plan = d.metadata?.plan ? `${d.metadata.plan} (${d.metadata.interval ?? '?'})` : d.product?.name ?? '';
  const money = d.amount && d.currency ? `${d.amount} ${d.currency}` : '';

  switch (event.type) {
    case 'customer.subscription.created':
      return `💰 New subscription: ${plan}\n${who}\n${money}\nAction: email them within 1 business day.`;
    case 'invoice.paid':
      return `🧾 Invoice paid: ${who} ${money}`;
    case 'invoice.payment_failed':
      return `⚠️ Renewal payment failed: ${who} ${money}. Bachs is retrying.`;
    case 'customer.subscription.updated':
      return `🔄 Subscription updated: ${who} → ${d.status ?? 'changed'}${d.cancel_at_period_end ? ' (cancels at period end)' : ''}`;
    case 'customer.subscription.deleted':
      return `❌ Subscription cancelled: ${who} ${plan}`;
    case 'collection.succeeded':
      return null; // covered by subscription.created / invoice.paid
    case 'refund.paid':
      return `↩️ Refund paid: ${money}`;
    case 'dispute.created':
      return `🚨 Dispute opened: ${money}. Respond in the Bachs dashboard before the deadline.`;
    default:
      return null;
  }
}

export const onRequestPost = async ({ request, env }: Context): Promise<Response> => {
  if (!env.BACHS_WEBHOOK_SECRET) {
    console.error('BACHS_WEBHOOK_SECRET is not set');
    return new Response('not configured', { status: 503 });
  }

  const raw = await request.text();
  if (!(await verify(request, raw, env.BACHS_WEBHOOK_SECRET))) {
    return new Response('invalid signature', { status: 401 });
  }

  let event: BachsEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response('invalid payload', { status: 400 });
  }

  if (env.SALES_EVENTS) {
    await env.SALES_EVENTS.put(`event:${event.created_at ?? ''}:${event.id}`, raw);
  }

  const text = describe(event);
  if (text && env.SALES_TELEGRAM_BOT_TOKEN && env.SALES_TELEGRAM_CHAT_ID) {
    const res = await fetch(`https://api.telegram.org/bot${env.SALES_TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.SALES_TELEGRAM_CHAT_ID, text }),
    });
    if (!res.ok) console.error(`telegram notify failed: ${res.status}`);
  }

  return new Response('ok');
};
