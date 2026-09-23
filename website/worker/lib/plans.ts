// Plan limits and how a subscription becomes an entitlement.
//
// Licensed under FSL-1.1-MIT (see website/LICENSE.md): use and self-host freely,
// but not as a competing product or service. Converts to MIT after two years.
import type { D1Database } from './env';

export type PaidPlan = 'pro' | 'team' | 'enterprise';

export interface Limits {
  servers: number;
  storageBytes: number;
  retentionDays: number;
}

const GB = 1024 ** 3;

// Keep in sync with src/data/plans.ts
export const LIMITS: Record<PaidPlan, Limits> = {
  pro: { servers: 5, storageBytes: 50 * GB, retentionDays: 30 },
  team: { servers: 20, storageBytes: 250 * GB, retentionDays: 90 },
  enterprise: { servers: 1000, storageBytes: 5000 * GB, retentionDays: 365 },
};

// past_due keeps access while Bachs retries the card
const ACTIVE = ['active', 'trialing', 'past_due'];
const RANK: Record<string, number> = { pro: 1, team: 2, enterprise: 3 };

export interface Entitlement {
  plan: PaidPlan | null;
  status: string | null;
  limits: Limits | null;
  subscriptionId: string | null;
  customerId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

interface SubRow {
  id: string;
  plan: string;
  status: string;
  customer_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: number;
}

export async function entitlementFor(db: D1Database, account: { id: string; emails: string[] }): Promise<Entitlement> {
  const emails = account.emails.length ? account.emails : [''];
  const placeholders = emails.map(() => '?').join(',');
  const { results } = await db
    .prepare(
      `SELECT id, plan, status, customer_id, current_period_end, cancel_at_period_end
       FROM subscriptions WHERE account_id = ? OR email IN (${placeholders})`
    )
    .bind(account.id, ...emails)
    .all<SubRow>();

  const active = results
    .filter((s) => ACTIVE.includes(s.status) && s.plan in LIMITS)
    .sort((a, b) => (RANK[b.plan] ?? 0) - (RANK[a.plan] ?? 0));

  const best = active[0];
  if (!best) {
    return { plan: null, status: results[0]?.status ?? null, limits: null, subscriptionId: null, customerId: results[0]?.customer_id ?? null, currentPeriodEnd: null, cancelAtPeriodEnd: false };
  }
  return {
    plan: best.plan as PaidPlan,
    status: best.status,
    limits: LIMITS[best.plan as PaidPlan],
    subscriptionId: best.id,
    customerId: best.customer_id,
    currentPeriodEnd: best.current_period_end,
    cancelAtPeriodEnd: Boolean(best.cancel_at_period_end),
  };
}
