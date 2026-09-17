---
title: Website and payments
description: How vigilops.cloud is deployed as a Cloudflare Worker and how paid plans are sold through Bachs.
---

The website, docs, installer URL and checkout all live in `website/` and deploy as one Cloudflare Worker, `vigilops`, at `vigilops.cloud`. The Worker serves the built site from `dist/` and handles the `/api/*` routes.

| Path | What it is |
|---|---|
| `src/pages/index.astro`, `pricing.astro`, `terms.astro`, ... | Marketing and legal pages |
| `src/data/plans.ts` | Plans, prices, comparison table and FAQ — the only place prices are set |
| `src/data/site.ts` | Install command, links, and business details used on legal pages |
| `src/content/docs/docs/` | These docs |
| `worker/index.ts` | Worker entry: routes `/api/*`, serves everything else from `dist/` |
| `worker/api/checkout.ts` | `POST /api/checkout`: creates a Bachs checkout session |
| `worker/api/bachs-webhook.ts` | `POST /api/bachs-webhook`: verifies Bachs events, records subscriptions, notifies sales on Telegram |
| `worker/api/auth.ts` | GitHub sign-in and sessions |
| `worker/api/app.ts` | Dashboard API (`/api/app/*`) |
| `worker/api/agent.ts` | Agent API (`/api/agent/*`): heartbeats, backup uploads and downloads |
| `worker/api/telegram.ts` | Official VigilOps bot webhook (linking chats) |
| `worker/cron.ts` | Every 15 minutes: offline servers, missed backups, retention |
| `migrations/` | D1 database schema |
| `src/pages/app/`, `src/pages/login.astro` | Dashboard and sign-in pages |
| `wrangler.jsonc` | Worker configuration |
| `scripts/copy-install.mjs` | Publishes `install.sh` at `https://vigilops.cloud/install.sh` on every build |

## Deploy to Cloudflare

1. In the Cloudflare dashboard: **Compute (Workers)** → **Workers & Pages** → **Create application** → **Continue with GitHub** → select `VigilOpsHq/vigil`.
2. Settings:

   | Setting | Value |
   |---|---|
   | Project name | `vigilops` (must match `name` in `wrangler.jsonc`) |
   | Build command | `npm run build` |
   | Deploy command | `npx wrangler deploy` |
   | Path (root directory) | `website` |
   | Build variable | `NODE_VERSION` = `22` |

3. **Deploy**. The site is then live at `vigilops.<your-subdomain>.workers.dev`.
4. Add the domain: the Worker → **Settings** → **Domains & Routes** → **Add** → **Custom domain** → `vigilops.cloud`, then again for `www.vigilops.cloud`. Because the domain is on Cloudflare, DNS and certificates are set up for you. Remove any existing DNS records for those names first if Cloudflare reports a conflict.
5. Every push to `main` redeploys. Other branches get preview builds.

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

In Cloudflare → the `vigilops` Worker → **Settings** → **Variables and Secrets**. Add each one with type **Secret** (product IDs can be **Text**). `keep_vars` in `wrangler.jsonc` stops Git deploys from removing them.

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

Optionally add a KV namespace binding named `SALES_EVENTS` to keep a copy of every verified event.

Changes to variables apply on the next deployment; use **Deployments** → **Retry** or push a commit.

### 4. Test in the sandbox

On `https://vigilops.cloud/pricing/`, pick Pro, enter an email and pay with a Bachs sandbox test card. You should land on `/checkout/success/` and get a "💰 New subscription" message on Telegram.

### 5. Go live

Verify your Bachs account, create the same products in **live** mode, then swap `BACHS_API_KEY`, `BACHS_API_BASE`, the product IDs and the webhook secret for live values, and redeploy.

## Set up VigilOps Cloud

VigilOps Cloud needs a database, a storage bucket, GitHub sign-in and the official Telegram bot. Do this once, then redeploy.

### 1. Database (D1)

Cloudflare → **Storage & databases** → **D1 SQL database** → **Create** → name it `vigilops`. Copy its **Database ID** into `website/wrangler.jsonc` (`d1_databases[0].database_id`) and commit.

Create the tables once from your computer:

```bash
cd website
npx wrangler login
npm run db:migrate
```

Run `npm run db:migrate` again whenever a new file appears in `migrations/`.

### 2. Backup storage (R2)

Cloudflare → **Storage & databases** → **R2** → **Create bucket** → name it `vigilops-backups` (it must match `r2_buckets[0].bucket_name`). Enabling R2 asks for a payment method; the first 10 GB and all downloads are free.

### 3. GitHub sign-in

GitHub → **Settings** → **Developer settings** → **OAuth Apps** → **New OAuth App** (create it under the VigilOpsHq organisation):

| Field | Value |
|---|---|
| Application name | VigilOps Cloud |
| Homepage URL | `https://vigilops.cloud` |
| Authorization callback URL | `https://vigilops.cloud/auth/github/callback` |

Generate a client secret, then add to the Worker's **Variables and Secrets**:

| Variable | Type | Value |
|---|---|---|
| `GITHUB_CLIENT_ID` | Text | the Client ID |
| `GITHUB_CLIENT_SECRET` | Secret | the client secret |

### 4. The official VigilOps bot

Create a bot with @BotFather (for example `@VigilOpsBot`). This is the bot customers link in the dashboard; don't reuse a server's bot. Add:

| Variable | Type | Value |
|---|---|---|
| `CLOUD_TELEGRAM_BOT_TOKEN` | Secret | the bot token |
| `CLOUD_TELEGRAM_BOT_USERNAME` | Text | the bot's username, without `@` |
| `CLOUD_TELEGRAM_WEBHOOK_SECRET` | Secret | a random string: `openssl rand -hex 32` |

After deploying, point the bot at the Worker once:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://vigilops.cloud/api/telegram/webhook" \
  -d "secret_token=<CLOUD_TELEGRAM_WEBHOOK_SECRET>" \
  -d 'allowed_updates=["message"]'
```

### 5. Deploy command

In the Worker's **Settings** → **Build**, set the deploy command to:

```bash
npx wrangler d1 migrations apply DB --remote && npx wrangler deploy
```

so new database migrations are applied on every deploy. If the build token isn't allowed to edit D1, keep `npx wrangler deploy` and run `npm run db:migrate` yourself when migrations change.

### Check it

1. Open `https://vigilops.cloud/app/` and sign in with GitHub.
2. Buy a plan in the Bachs sandbox with the same email as your GitHub account. The dashboard shows the plan within a minute.
3. **Add server**, run `vigil cloud connect <token>` on a server running VigilOps 1.1.0 or newer, then `vigil backup <container>`.
4. The backup appears in the dashboard; **Download** works.
5. **Connect Telegram**, then stop VigilOps on a test server (`vigil stop`). Within 30 minutes the bot says it's offline.

## What happens after someone pays

1. Bachs sends `customer.subscription.created`; the Worker records the subscription and the sales bot tells you.
2. The customer signs in at `/app` with GitHub. The plan unlocks when one of their verified GitHub emails matches the email they paid with, or immediately if they were signed in when they checked out.
3. Cancellations and failed renewals (`customer.subscription.updated` / `deleted`) lock Cloud features automatically. Existing backups stay downloadable for 30 days.
4. Support is still delivered by you: reply within the times on the pricing page.

If a customer paid with an email that isn't on their GitHub account, link it by hand:

```bash
npx wrangler d1 execute DB --remote --command "UPDATE subscriptions SET account_id = (SELECT id FROM accounts WHERE login = '<github-username>') WHERE email = '<email they paid with>'"
```

## Before launch

- Fill in the business details in `src/data/site.ts`. Until then, the terms, privacy and refund pages show a "Draft" notice.
- Have the terms, privacy policy and refund policy reviewed for your country.
- Set up the `hello@` and `support@vigilops.cloud` addresses, for example with Cloudflare Email Routing.

## Run locally

```bash
cd website
npm install
npm run dev              # site and docs at http://localhost:4321 (no API routes)
```

To test the Worker with its API routes, copy `.dev.vars.example` to `.dev.vars`, fill in sandbox values, then:

```bash
npm run preview:worker   # builds, then serves the Worker at http://localhost:8787
```
