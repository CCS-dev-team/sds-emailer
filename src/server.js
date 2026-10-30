require('dotenv').config();

const express = require('express');
const { verifyWebhook } = require('./verifyWebhook');
const { findSdsItems } = require('./sds');
const { initSendGrid, sendSdsEmail } = require('./email');
const { JsonStore } = require('./store');
const { getAdminAccessToken } = require('./auth');
const oauth = require('./oauth');
const { checkExclusions } = require('./exclusions');

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
  fail('set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET ( Dev Dashboard app) so the access token can be requested via the client credentials grant');
}
if (!process.env.SENDGRID_API_KEY) fail('SENDGRID_API_KEY is not set');
if (!process.env.SENDGRID_FROM) fail('SENDGRID_FROM is not set');

/**
 * Topics we ACCEPT on the wire.
 *
 * Both subscriptions stay registered on the store:
 *  - orders/paid      fires when payment is captured
 *  - orders/fulfilled fires when the order is fulfilled (goods dispatched)
 *
 * Keeping both subscribed means a delivery for either topic always gets a
 * valid HMAC-verified 200 here (never a 4xx), so Shopify never burns through
 * its 8-retry budget and never deletes the subscription.
 */
const ALLOWED_TOPICS = new Set(['orders/paid', 'orders/fulfilled']);

/**
 * Topics that actually TRIGGER the SDS email — i.e. the moment the goods leave
 * the warehouse and the customer starts storing / handling the chemicals.
 *
 * Default: dispatch only (orders/fulfilled). orders/paid still arrives and is
 * acknowledged with a 200, but sends nothing, so the customer no longer gets
 * their SDS email at checkout.
 *
 * Override without touching code if you ever want payment to trigger it again:
 *   SDS_TRIGGER_TOPICS=orders/paid,orders/fulfilled
 *   SDS_TRIGGER_TOPICS=orders/paid
 *
 * About courier / automatic tracking updates: those are fulfilment events too.
 * As long as the order gets a real Shopify fulfilment (manual dispatch OR a
 * fulfilment created by the courier's tracking app), orders/fulfilled fires
 * once the order is COMPLETELY fulfilled. A tracking-number-only update on an
 * already-fulfilled order does not fire it again, and a partial (multi-box)
 * fulfilment does not fire it until the last parcel is fulfilled — that order
 * is emailed once, on the final parcel.
 */
const TRIGGER_TOPICS = new Set(
  (process.env.SDS_TRIGGER_TOPICS || 'orders/fulfilled')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => ALLOWED_TOPICS.has(t))
);

if (TRIGGER_TOPICS.size === 0) {
  fail('SDS_TRIGGER_TOPICS does not contain a supported topic (use orders/fulfilled and/or orders/paid)');
}

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
    console.error(`[webhook] HMAC verification failed for shop=${shop} topic=${topic}`);
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

  // 3. Dispatch-only gate. orders/paid is acknowledged (200) but not acted on,
  //    so no email goes out at checkout. Nothing is written to the sent-order
  //    ledger, so the later orders/fulfilled delivery is still free to send.
  if (!TRIGGER_TOPICS.has(topic)) {
    if (webhookId) store.mark(webhookId);
    console.log(
      `[webhook] ${topic} for order ${order.id} on ${shop} — not a dispatch event, no email sent`
    );
    return res.status(200).json({ ok: true, emailsSent: 0, reason: 'not a dispatch event', topic });
  }

  try {
    // 4. Get a valid Admin API access token (OAuth token takes priority)
    const accessToken = await getAdminAccessToken();

    // 5. Order-level guard — only ONE SDS email per order, even when the same
    //    order is fulfilled in several parcels or Shopify retries a delivery.
    if (order.id && store.orderSent(order.id)) {
      if (webhookId) store.mark(webhookId);
      return res.status(200).json({ ok: true, skipped: 'order already emailed' });
    }

    // 6. Opt-out check (metafield-driven).
    //    A flag on the B2B Company suppresses EVERY location and contact under
    //    it (existing and future); a flag on the Customer suppresses that
    //    buyer only. Placed BEFORE findSdsItems() so an excluded order costs
    //    no extra product lookups. Returns HTTP 200 (never 4xx) so Shopify
    //    does not retry the delivery.
    const exclusion = await checkExclusions(shop, accessToken, order);
    if (exclusion.excluded) {
      console.log(
        `[webhook] Skipping order ${order.id} on ${shop} — ${exclusion.scope} ` +
          `"${exclusion.name}" (${exclusion.id}) opted out via ${exclusion.metafield}`
      );
      if (webhookId) store.mark(webhookId);
      // Deliberately NOT store.markOrderSent(): the order was never emailed, so
      // it is not recorded as emailed. Clear the metafield flag and the order
      // can be emailed normally again.
      return res.status(200).json({
        ok: true,
        emailsSent: 0,
        reason: 'opt-out metafield',
        scope: exclusion.scope,
        id: exclusion.id,
      });
    }

    // 7. Map line items -> product GIDs
    const lineItems = (order.line_items || []).map((li) => ({
      title: li.title,
      sku: li.sku,
      productId: li.product_id ? `gid://shopify/Product/${li.product_id}` : null,
    }));

    // 8. Keep only unique products that are in an applicable category
    //    AND have a populated custom.download_pdf_file metafield
    const sdsItems = await findSdsItems(shop, accessToken, { lineItems });

    if (sdsItems.length === 0) {
      // No chemical products with an SDS — nothing to email
      console.log(`[webhook] No SDS items for order ${order.id} on ${shop}`);
      if (webhookId) store.mark(webhookId);
      return res.status(200).json({ ok: true, emailsSent: 0 });
    }

    // 9. Send the SDS email
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
      `[webhook] SDS email sent for order ${order.id} -> ${to} (${sdsItems.length} item(s)) ` +
        `via ${topic} on ${shop}`
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

app.get('/health', (req, res) =>
  res.json({
    ok: true,
    triggers: Array.from(TRIGGER_TOPICS),
    accepts: Array.from(ALLOWED_TOPICS),
  })
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SDS emailer listening on port ${PORT}`);
  console.log(`[config] Sending SDS email on: ${Array.from(TRIGGER_TOPICS).join(', ')}`);
});
