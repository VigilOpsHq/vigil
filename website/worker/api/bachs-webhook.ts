// POST /api/bachs-webhook
// Verifies Bachs events, records subscriptions (which unlock plans) and notifies the team on Telegram.

import type { Env, RequestContext } from '../lib/env';
import { hmacHex, safeEqual } from '../lib/crypto';
import { sendTelegram } from '../lib/telegram';

interface BachsEvent {
  id: string;
  type: string;
  created_at?: string;
  data?: Record<string, any>;
}

const TOLERANCE_SECONDS = 300;

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

function planFromProduct(env: Env, productId: string | undefined): { plan: string; interval: string } | null {
  if (!productId) return null;
  for (const plan of ['pro', 'team']) {
    for (const interval of ['monthly', 'yearly']) {
      if (env[`BACHS_PRODUCT_${plan.toUpperCase()}_${interval.toUpperCase()}`] === productId) return { plan, interval };
    }
  }
  return null;
}

async function recordSubscription(env: Env, event: BachsEvent): Promise<void> {
  if (!env.DB || !event.type.startsWith('customer.subscription.')) return;
  const d = event.data ?? {};
  const id = String(d.id ?? '');
  const email = String(d.customer?.email ?? d.customer_details?.email ?? '').toLowerCase();
  if (!id.startsWith('sub_') || !email) {
    console.error(`subscription event without id/email: ${event.id}`);
    return;
  }

  const fromProduct = planFromProduct(env, d.product?.id ?? d.items?.[0]?.product_id);
  const plan = String(d.metadata?.plan ?? fromProduct?.plan ?? '');
  if (!['pro', 'team', 'enterprise'].includes(plan)) {
    console.error(`subscription ${id}: unknown plan`);
    return;
  }
  const interval = String(d.metadata?.interval ?? fromProduct?.interval ?? '');
  const status = event.type === 'customer.subscription.deleted' ? 'canceled' : String(d.status ?? 'active');
  const accountId = typeof d.metadata?.account_id === 'string' ? d.metadata.account_id : null;

  await env.DB.prepare(
    `INSERT INTO subscriptions (id, account_id, customer_id, email, plan, interval, status, current_period_end, cancel_at_period_end, updated_at)
     VALUES (?, (SELECT id FROM accounts WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       account_id = COALESCE(subscriptions.account_id, excluded.account_id),
       customer_id = COALESCE(excluded.customer_id, subscriptions.customer_id),
       email = excluded.email, plan = excluded.plan, interval = excluded.interval, status = excluded.status,
       current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end,
       updated_at = excluded.updated_at`
  )
    .bind(
      id,
      accountId,
      d.customer?.customer_id ?? d.customer?.id ?? null,
      email,
      plan,
      interval,
      status,
      d.current_period_end ?? null,
      d.cancel_at_period_end ? 1 : 0,
      new Date().toISOString()
    )
    .run();
}

function describe(event: BachsEvent): string | null {
  const d = event.data ?? {};
  const who = d.customer?.email ?? d.customer_details?.email ?? 'unknown customer';
  const plan = d.metadata?.plan ? `${d.metadata.plan} (${d.metadata.interval ?? '?'})` : d.product?.name ?? '';
  const money = d.amount && d.currency ? `${d.amount} ${d.currency}` : '';

  switch (event.type) {
    case 'customer.subscription.created':
      return `💰 New subscription: ${plan}\n${who}\n${money}\nThey can sign in at vigilops.cloud/app with GitHub (same email) to connect servers.`;
    case 'invoice.paid':
      return `🧾 Invoice paid: ${who} ${money}`;
    case 'invoice.payment_failed':
      return `⚠️ Renewal payment failed: ${who} ${money}. Bachs is retrying.`;
    case 'customer.subscription.updated':
      return `🔄 Subscription updated: ${who} → ${d.status ?? 'changed'}${d.cancel_at_period_end ? ' (cancels at period end)' : ''}`;
    case 'customer.subscription.deleted':
      return `❌ Subscription cancelled: ${who} ${plan}`;
    case 'refund.paid':
      return `↩️ Refund paid: ${money}`;
    case 'dispute.created':
      return `🚨 Dispute opened: ${money}. Respond in the Bachs dashboard before the deadline.`;
    default:
      return null;
  }
}

export async function bachsWebhook({ request, env }: RequestContext): Promise<Response> {
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

  if (env.DB && event.id) {
    const { meta } = await env.DB.prepare('INSERT OR IGNORE INTO webhook_events (id, type) VALUES (?, ?)').bind(event.id, event.type).run();
    if (meta.changes === 0) return new Response('duplicate');
  }

  try {
    await recordSubscription(env, event);
  } catch (err) {
    // Let Bachs retry: forget the event so the retry is processed
    if (env.DB && event.id) await env.DB.prepare('DELETE FROM webhook_events WHERE id = ?').bind(event.id).run();
    console.error('failed to record subscription', err);
    return new Response('error', { status: 500 });
  }

  const text = describe(event);
  if (text) await sendTelegram(env.SALES_TELEGRAM_BOT_TOKEN, env.SALES_TELEGRAM_CHAT_ID, text);

  return new Response('ok');
}
