# Central Cleaning Supplies — SDS Emailer (Shopify app)

A small Node.js/Express app that automatically emails Safety Data Sheet (SDS)
links to customers after they place an order containing a chemical product.

When an order is paid, the app:

1. receives the Shopify `orders/paid` webhook (HMAC-verified),
2. inspects each line item's product,
3. keeps only products that are in an applicable category **and** have a
   populated `custom.download_pdf_file` metafield,
4. sends one email per order via **SendGrid**, listing one row per qualifying
   product (`Product name SKU - URL`).

---

## How it works

```
Customer pays
      │
      ▼
Shopify ── POST /webhooks/orders/paid (HMAC-signed) ──▶ Express app
      │                                                        │
      │                                         1. verify HMAC signature
      │                                         2. dedupe by X-Shopify-Webhook-Id
      │                                         3. collect product GIDs from line items
      │                                         4. GraphQL query (batched "nodes"):
      │                                              • product type
      │                                              • collection titles
      │                                              • custom.download_pdf_file metafield
      │                                                (supports "url" and "file_reference" types)
      │                                         5. filter: category match + SDS URL present
      │                                         6. SendGrid email (HTML + plain text)
      ▼
Customer receives "Safety Data Sheets (SDS) for your recent chemical purchase"
```

## Categories

The six categories are matched **case-insensitively** against **both**:

- the product's **Product type** (`productType`), and
- the titles of the **collections** the product belongs to

| Category |
| --- |
| Chemicals |
| Odour Control |
| Eco Friendly Chemicals |
| Hand Sanitiser |
| Hand Soap |
| Hand Wipes |

A product qualifies only if it is in one of these categories **AND** its
`custom.download_pdf_file` metafield contains a URL.

> This is deliberately flexible: as long as products are assigned to matching
> collections or typed accordingly in your catalog, no code changes are
> needed. You can extend or narrow the list via the `SDS_CATEGORIES` env var.

## The metafield: `custom.download_pdf_file`

The app supports both metafield types Shopify allows for "Download pdf file":

| Metafield type | What the app reads |
| --- | --- |
| `url` | the `value` directly (the URL) |
| `file_reference` | `reference { ... on GenericFile { url } }` — the real file URL |

Line items with an empty/invalid metafield are skipped. If an order ends up
with **zero** qualifying products, no email is sent at all.

## Email content

The email copy is exactly as specified:

- **Subject:** Safety Data Sheets (SDS) for your recent chemical purchase
- **Body:** `Hi {{ first name or "there" }}`, the supplied paragraphs, one
  row per product (`Product name SKU - URL`), and the closing/contact text.

Both **HTML** and **plain-text** versions are sent.

> The copy says the app has "forwarded you links to download" the SDS, and
> that is exactly what happens: the email contains **links** to the documents.
> If you ever need the PDF **attached** to the email instead, the app would
> have to download each PDF and pass it to SendGrid's attachment API — say
> the word if you'd like that variant.

## Prerequisites

- Node.js 18+
- A Shopify app created in the **Dev Dashboard** (the only option since
  January 1, 2026 — legacy custom apps can no longer be created).
  - You only need the app's **Client ID** and **Client secret** from
    Dev Dashboard → Apps → *your app* → App settings → Credentials.
  - The app requests its Admin API access token itself via the **client
    credentials grant** (tokens last ~24h and are refreshed automatically),
    so there is no token to copy.
  - The app must still be granted the Admin API scopes `read_orders` and
    `read_products` for your store (where your store admin lists the app's
    API access — see “Manage access scopes” in the Shopify docs if the
    location differs in your dashboard).
- A Twilio SendGrid account with:
  - an API key, and
  - a **verified sender** (domain or single sender) for the From address.

## Setup

1. Clone/copy this repo and install dependencies:

   ```bash
   npm install
   ```

2. Create your configuration:

   ```bash
   cp .env.example .env
   ```

   Then fill in every value (see the [Configuration](#configuration) table).
   For a Dev Dashboard app you only need the **Client ID** and **Client
   secret** from App settings → Credentials — the app obtains and refreshes
   the Admin API access token itself via the client credentials grant.

3. Make sure the app is reachable over **HTTPS** (Shopify rejects HTTP
   callback URLs in production). Deploy to any Node host (Render, Fly.io,
   Railway, Heroku, EC2…) or tunnel locally during development
   (`cloudflared tunnel`, `ngrok`…).

4. Register the webhook subscription (one-off):

   ```bash
   npm run register-webhook
   ```

   The script creates an `ORDERS_PAID` subscription pointing at your
   `WEBHOOK_CALLBACK_URL`. You can also create it manually in
   **Shopify Admin → Settings → Notifications → Webhooks**.

5. Start the app:

   ```bash
   npm start
   ```

6. Smoke-test with a real test order (Shopify's "Buy button" or checkout a
   chemical product on a test order), then check the app logs and SendGrid
   Email Activity feed.

## Deploying to Render (Option B — recommended)

The app is Render-ready: it reads the port from `process.env.PORT` (Render
sets this automatically), pins Node via `engines`, and ships an optional
`render.yaml` blueprint.

### 1. Push the project to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
# create an empty repo on github.com, then:
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/sds-emailer.git
git push -u origin main
```

`.env` is in `.gitignore`, so your secrets are **not** pushed — double-check
that no `.env` file appears in the GitHub repo after the push.

### 2. Create the web service on Render

1. Sign in at [render.com](https://render.com) with GitHub.
2. **New → Web Service** → connect your `sds-emailer` repository.
3. Render auto-detects Node.js. Leave:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Pick a plan — see the free-tier note below.
5. Expand **Advanced** or use the **Environment** tab and add every variable
   from the Configuration table below, plus:

   | Variable | Value |
   | --- | --- |
   | `WEBHOOK_CALLBACK_URL` | `https://<your-app-name>.onrender.com/webhooks/orders/paid` |

   Do **not** copy the legacy/optional rows (`SHOPIFY_ADMIN_ACCESS_TOKEN`,
   `SHOPIFY_API_SECRET`) — leave them unset for a Dev Dashboard app.
6. **Deploy Web Service**, then watch the logs for
   `SDS emailer listening on port <port>`. Open
   `https://<your-app-name>.onrender.com/health` — you should see `{"ok":true}`.

### 3. Register the webhook against the Render URL

Set `WEBHOOK_CALLBACK_URL` in your **local** `.env` to the Render URL, then
run locally:

```bash
npm run register-webhook
```

…or create it manually in **Shopify admin → Settings → Notifications →
Webhooks**: topic `Order created`/`Orders paid`, URL
`https://<your-app-name>.onrender.com/webhooks/orders/paid`.

### 4. Point the app URL in the Dev Dashboard

If your app's Dev Dashboard **App settings** requires an app URL, set it to
`https://<your-app-name>.onrender.com`. No OAuth redirect URLs are needed for
this setup (there is no browser install flow).

### 5. Test with a real order

Place an order containing a chemical product with a populated
`custom.download_pdf_file` metafield, then check the Render **Logs**
(`SDS email sent for order …`) and SendGrid **Email Activity**.

### Free-tier note (important)

Render's **free** web services **spin down after 15 minutes without inbound
traffic** and the next request pays a ~1 minute cold start
[Render free tier](https://render.com/docs/free). For a quiet store, the
first webhook after idle can therefore arrive late, and Shopify may log a
failed delivery attempt before the retry succeeds (Shopify retries deliveries
for hours, so emails eventually arrive). For production, upgrade to
**Starter (~$7/month)** — instances never spin down. A keep-alive cron that
hits `/health` every few minutes is a partial workaround, not a guarantee.

Also note Render's filesystem is **ephemeral**: the `PROCESSED_ORDERS_FILE`
dedupe file resets on every deploy/restart. That is harmless at this scale
(Shopify retries are idempotent at the order level), but if you ever need
strict once-only delivery, move the dedupe store to a database.

## Configuration

| Variable | Description |
| --- | --- |
| `SHOPIFY_SHOP_DOMAIN` | Store's myshopify domain, e.g. `store.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | Dev Dashboard app Client ID (App settings → Credentials) |
| `SHOPIFY_CLIENT_SECRET` | Dev Dashboard app Client secret — used for the client credentials grant **and** webhook HMAC verification |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | *Optional, legacy only*: a long-lived `shpat_…` token from a pre-2026 custom app; takes priority over the credentials grant |
| `SHOPIFY_API_SECRET` | *Optional, legacy only*: pre-2026 API secret key for webhook HMAC when the client secret is not set |
| `SHOPIFY_API_VERSION` | Admin API version, default `2026-07` (latest stable) |
| `WEBHOOK_CALLBACK_URL` | Public HTTPS URL, e.g. `https://app.example.com/webhooks/orders/paid` |
| `SENDGRID_API_KEY` | SendGrid API key |
| `SENDGRID_FROM` | Verified sender address used in the From header |
| `SDS_CATEGORIES` | Comma-separated categories; defaults to the six above |
| `PROCESSED_ORDERS_FILE` | JSON file path used for webhook idempotency |

## Reliability notes

- **HMAC verification** — every delivery is verified with `X-Shopify-Hmac-SHA256`
  against the raw request body using your app's client secret (Dev Dashboard)
  or legacy API secret. Failures return `401`.
- **Idempotency** — Shopify retries unacknowledged deliveries (up to 8 times
  over ~4 hours) and can send duplicates. The app remembers processed
  `X-Shopify-Webhook-Id` values and skips repeats.
- **At-least-once semantics** — the email is sent *after* filtering, and the
  delivery is only marked processed after the SendGrid call succeeds. If the
  send fails, Shopify retries, so a customer *could* receive two emails in a
  rare crash window. If that matters, record `SENT` against the SendGrid
  message id before returning 200 and skip already-sent orders.
- **No qualifying items** — no email is sent (delivery marked processed).
- **Missing customer email** — skipped and logged, no email sent.

## Production considerations

- The default `JsonStore` is fine for small stores; replace it with a
  real database or Shopify's app storage when you outgrow it (the `has` /
  `mark` interface stays the same).
- If you run multiple stores on one instance, look up the admin token per
  `X-Shopify-Shop-Domain` instead of a single env token.
- If you rotate the app's API secret, Shopify needs up to an hour to sign
  webhooks with the new secret — keep the old value until then.
- Keep `PROCESSED_ORDERS_FILE` on persistent storage (not the container's
  ephemeral disk) so dedupe survives restarts.

## Project layout

```
├── src/
│   ├── server.js            # Express app + webhook route
│   ├── verifyWebhook.js     # HMAC-SHA256 signature verification
│   ├── shopify.js           # Admin GraphQL client
│   ├── sds.js               # category filter + metafield resolution + query
│   ├── template.js          # exact email copy (HTML + text)
│   ├── email.js             # SendGrid integration
│   ├── store.js             # idempotency store (JSON file)
│   └── registerWebhook.js   # one-off webhook registration script
├── shopify.app.toml         # Shopify CLI config (scopes, API version)
├── .env.example
└── package.json
```
