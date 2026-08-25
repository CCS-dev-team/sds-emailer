require('dotenv').config();

const express = require('express');
const { verifyWebhook } = require('./verifyWebhook');
const { findSdsItems } = require('./sds');
const { initSendGrid, sendSdsEmail } = require('./email');
const { JsonStore } = require('./store');
const { getAdminAccessToken } = require('./auth');
const oauth = require('./oauth');

const app = express();
app.disable('x-powered-by');

initSendGrid();

const store = new JsonStore();

// Dev Dashboard apps verify webhook signatures with the client secret;
// pre-2026 legacy apps used the API secret key.
const webhookSecret = process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_CLIENT_SECRET;

function fail(message) {
  console.error(`Configuration error: ${message} (see .env.example)`);
  process.exit(1);
}

if (!process.env.SHOPIFY_SHOP_DOMAIN) fail('SHOPIFY_SHOP_DOMAIN is not set');
if (!webhookSecret) {
  fail('set SHOPIFY_CLIENT_SECRET (Dev Dashboard app) or SHOPIFY_API_SECRET (legacy) for webhook HMAC verification');
}
if (!process.env.SHOPIFY_ADMIN_ACCESS_TOKEN && !(process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET)) {
  fail('set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (Dev Dashboard app) so the access token can be requested via the client credentials grant');
}
if (!process.env.SENDGRID_API_KEY) fail('SENDGRID_API_KEY is not set');
if (!process.env.SENDGRID_FROM) fail('SENDGRID_FROM is not set');

/**
 * Topics that trigger the SDS email:
 *  - orders/paid      fires when payment is captured (paid-upfront orders)
 *  - orders/fulfilled fires when the order is fulfilled / goods dispatched.
 *
 * The fulfilled topic is essential for Net-term orders: orders/paid does NOT
 * fire until the customer actually settles the invoice (could be 30+ days
 * later, or never inside Shopify). Fulfilment happens at dispatch — the
 * moment the customer starts storing/handling the chemicals and needs the
 * SDS. The order-level idempotency guard below ensures only ONE email per
 * order even when both topics fire.
 */
const ALLOWED_TOPICS = new Set(['orders/paid', 'orders/fulfilled']);

/**
 * Shared webhook processor (HMAC-verified).
 *
 * IMPORTANT: express.raw() is registered per-route BEFORE any body-parsing
 * middleware so `req.body` is the exact raw bytes Shopify signed — HMAC
 * verification requires the unparsed body.
 */
async function handleOrderWebhook(req, res) {
  const hmac = req.get('X-Shopify-Hmac-SHA256') || '';
  const shop = req.get('X-Shopify-Shop-Domain') || '';
  const topic = req.get('X-Shopify-Topic') || '';
  const webhookId = req.get('X-Shopify-Webhook-Id') || '';

  if (!ALLOWED_TOPICS.has(topic)) {
    return res.status(400).json({ error: 'Unexpected webhook topic' });
  }

  // 1. Confirm the delivery really came from Shopify
  if (!verifyWebhook(req.body, hmac, webhookSecret)) {
    console.error(`[webhook] HMAC verification failed for shop=${shop}`);
    return res.status(401).json({ error: 'Invalid HMAC signature' });
  }

  // 2. Idempotency guard — Shopify may deliver the same event multiple times
  if (webhookId && store.has(webhookId)) {
    return res.status(200).json({ skipped: 'duplicate delivery' });
  }

  let order;
  try {
    order = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  try {
    // 2.5 Get a valid Admin API access token (OAuth token takes priority)
    const accessToken = await getAdminAccessToken();

    // 2.6 Cross-topic guard — only ONE SDS email per order, even if both
    //     orders/fulfilled and orders/paid fire for the same order.
    if (order.id && store.orderSent(order.id)) {
      if (webhookId) store.mark(webhookId);
      return res.status(200).json({ ok: true, skipped: 'order already emailed' });
    }

    // 3. Map line items -> product GIDs
    const lineItems = (order.line_items || []).map((li) => ({
      title: li.title,
      sku: li.sku,
      productId: li.product_id ? `gid://shopify/Product/${li.product_id}` : null,
    }));

    // 4. Keep only unique products that are in an applicable category
    //    AND have a populated custom.download_pdf_file metafield
    const sdsItems = await findSdsItems(shop, accessToken, { lineItems });

    if (sdsItems.length === 0) {
      // No chemical products with an SDS — nothing to email
      console.log(`[webhook] No SDS items for order ${order.id} on ${shop}`);
      if (webhookId) store.mark(webhookId);
      return res.status(200).json({ ok: true, emailsSent: 0 });
    }

    // 5. Send the SDS email
    const to = order.email;
    if (!to) {
      console.warn(`[webhook] Order ${order.id} has no customer email address; skipping`);
      if (webhookId) store.mark(webhookId);
      return res.status(200).json({ ok: true, emailsSent: 0, reason: 'no customer email' });
    }

    const firstName = order.customer?.first_name || '';
    await sendSdsEmail({ to, firstName, items: sdsItems });

    if (order.id) store.markOrderSent(order.id);
    if (webhookId) store.mark(webhookId);
    console.log(
      `[webhook] SDS email sent for order ${order.id} -> ${to} (${sdsItems.length} item(s)) on ${shop}`
    );
    return res.status(200).json({ ok: true, emailsSent: sdsItems.length });
  } catch (err) {
    // Return an error status so Shopify retries (up to 8 attempts over ~4 hours)
    console.error(`[webhook] Processing failed for shop=${shop}, order=${order.id}:`, err);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}

app.post('/webhooks/orders/paid', express.raw({ type: '*/*' }), handleOrderWebhook);
app.post('/webhooks/orders/fulfilled', express.raw({ type: '*/*' }), handleOrderWebhook);

/**
 * ---------- OAuth install flow (authorization code grant) ----------
 * Run ONCE, locally, to obtain a store access token for a production store
 * that is not in the app's Dev Dashboard organization.
 *
 *   1. npm start        (locally)
 *   2. open http://localhost:3000/auth/install
 *   3. approve the app in the Shopify approval screen
 *   4. the callback prints the access token and saves the response to
 *      data/shopify-token.json
 *   5. paste the token into SHOPIFY_ADMIN_ACCESS_TOKEN (.env + Render)
 */
app.get('/auth/install', (req, res) => {
  if (!process.env.SHOPIFY_SHOP_DOMAIN || !process.env.SHOPIFY_CLIENT_ID) {
    return res.status(500).send('Missing SHOPIFY_SHOP_DOMAIN / SHOPIFY_CLIENT_ID in .env');
  }
  const redirectUri =
    process.env.APP_REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/auth/callback`;
  res.redirect(
    oauth.buildInstallUrl(process.env.SHOPIFY_SHOP_DOMAIN, process.env.SHOPIFY_CLIENT_ID, redirectUri)
  );
});

app.get('/auth/callback', async (req, res) => {
  try {
    const check = oauth.verifyCallback(req.query, webhookSecret);
    if (!check.ok) return res.status(400).send(`Callback validation failed: ${check.error}`);
    if (!req.query.code) return res.status(400).send('Missing authorization code');

    const redirectUri =
      process.env.APP_REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/auth/callback`;
    const data = await oauth.exchangeCode(
      check.shop,
      process.env.SHOPIFY_CLIENT_ID,
      process.env.SHOPIFY_CLIENT_SECRET,
      req.query.code,
      redirectUri
    );

    const file = oauth.saveToken(data);
    console.log('OAuth install complete. Access token:', data.access_token);
    if (data.refresh_token) {
      console.log('Refresh token present (expires in', data.refresh_token_expires_in, 's)');
    }

    res
      .status(200)
      .send(
        '<h2>Installation complete</h2>' +
          '<p>Copy the access token below into <code>SHOPIFY_ADMIN_ACCESS_TOKEN</code> ' +
          'in <code>.env</code> and in Render\'s Environment, then restart/redeploy.</p>' +
          `<p><code>${data.access_token}</code></p>` +
          `<p>Token also saved to <code>${file}</code>.</p>`
      );
  } catch (err) {
    console.error('OAuth callback failed:', err);
    res.status(500).send(`OAuth callback failed: ${err.message}`);
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SDS emailer listening on port ${PORT}`);
});
