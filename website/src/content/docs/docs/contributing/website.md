---
title: Website and payments
description: How vigilops.cloud is deployed on Cloudflare Pages and how paid plans are sold through Bachs.
---

The website, docs, installer URL and checkout all live in `website/` and deploy to Cloudflare Pages at `vigilops.cloud`.

| Path | What it is |
|---|---|
| `src/pages/index.astro`, `pricing.astro`, `terms.astro`, ... | Marketing and legal pages |
| `src/data/plans.ts` | Plans, prices, comparison table and FAQ — the only place prices are set |
| `src/data/site.ts` | Install command, links, and business details used on legal pages |
| `src/content/docs/docs/` | These docs |
| `functions/api/checkout.ts` | `POST /api/checkout`: creates a Bachs checkout session |
| `functions/api/bachs-webhook.ts` | `POST /api/bachs-webhook`: verifies Bachs events and posts them to Telegram |
| `scripts/copy-install.mjs` | Publishes `install.sh` at `https://vigilops.cloud/install.sh` on every build |

## Deploy to Cloudflare Pages

1. In the Cloudflare dashboard: **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → `VigilOpsHq/vigil`.
2. Build settings:

   | Setting | Value |
   |---|---|
   | Framework preset | Astro |
   | Build command | `npm run build` |
   | Build output directory | `dist` |
   | Root directory | `website` |
   | Environment variable | `NODE_VERSION` = `22` |

3. After the first deploy: **Custom domains** → **Set up a custom domain** → `vigilops.cloud`, and again for `www.vigilops.cloud`. Because the domain is already on Cloudflare, DNS is set up for you.
4. Every push to `main` redeploys. Pull requests get preview URLs.

The `functions/` folder is deployed automatically as Pages Functions; no extra setup is needed.

## Sell plans with Bachs

Paid plans are Bachs **subscriptions**. A subscription starts when a customer completes a checkout for a recurring product. Bachs subscriptions currently bill USD cards.

### 1. Create the products

In the Bachs dashboard (start in the **sandbox**), create one recurring product per plan and billing period, with the prices from `src/data/plans.ts`:

| Product | Price | Billing cycle |
|---|---|---|
| VigilOps Pro (monthly) | 19.00 USD | 1 month |
| VigilOps Pro (yearly) | 190.00 USD | 1 year |
| VigilOps Team (monthly) | 49.00 USD | 1 month |
| VigilOps Team (yearly) | 490.00 USD | 1 year |

Copy each product's ID (`prod_...`). A product's billing cycle can't be changed later, so to change the cadence, create a new product.

### 2. Create the webhook

In the Bachs **Developer Portal** → **Webhooks** → **Add destination**:

- URL: `https://vigilops.cloud/api/bachs-webhook`
- Events: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `refund.paid`, `dispute.created`

Copy the endpoint's **signing secret**.

### 3. Set the environment variables

In Cloudflare Pages → your project → **Settings** → **Variables and Secrets** (Production). Mark keys and secrets as **Secret**.

| Variable | Value |
|---|---|
| `BACHS_API_KEY` | `sk_sandbox_...` while testing, `sk_live_...` when live |
| `BACHS_API_BASE` | `https://sandbox-api.bachs.io` while testing, `https://api.bachs.io` when live |
| `BACHS_WEBHOOK_SECRET` | The webhook signing secret |
| `BACHS_PRODUCT_PRO_MONTHLY` | `prod_...` |
| `BACHS_PRODUCT_PRO_YEARLY` | `prod_...` |
| `BACHS_PRODUCT_TEAM_MONTHLY` | `prod_...` |
| `BACHS_PRODUCT_TEAM_YEARLY` | `prod_...` |
| `SALES_TELEGRAM_BOT_TOKEN` | Bot that posts sales to you (use a separate bot from any server) |
| `SALES_TELEGRAM_CHAT_ID` | Your chat ID |

Optionally bind a KV namespace as `SALES_EVENTS` to keep a copy of every verified event.

Redeploy after changing variables.

### 4. Test in the sandbox

On `https://vigilops.cloud/pricing/`, pick Pro, enter an email and pay with a Bachs sandbox test card. You should land on `/checkout/success/` and get a "💰 New subscription" message on Telegram.

### 5. Go live

Verify your Bachs account, create the same products in **live** mode, then swap `BACHS_API_KEY`, `BACHS_API_BASE`, the product IDs and the webhook secret for live values, and redeploy.

## What happens after someone pays

Until VigilOps Cloud has its own backend, fulfilment is manual:

1. You get the Telegram message with the customer's email and plan.
2. Email them within one business day (the promise on the pricing and thank-you pages).
3. Customers manage or cancel their subscription through Bachs.

## Before launch

- Fill in the business details in `src/data/site.ts`. Until then, the terms, privacy and refund pages show a "Draft" notice.
- Have the terms, privacy policy and refund policy reviewed for your country.
- Set up the `hello@` and `support@vigilops.cloud` addresses, for example with Cloudflare Email Routing.

## Run locally

```bash
cd website
npm install
npm run dev              # site and docs at http://localhost:4321 (no checkout)
```

To test the checkout and webhook functions locally, copy `.dev.vars.example` to `.dev.vars`, fill in sandbox values, then:

```bash
npm run pages:dev        # builds, then serves with Functions at http://localhost:8788
```
