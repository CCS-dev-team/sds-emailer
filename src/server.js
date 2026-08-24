require('dotenv').config();

const express = require('express');
const { verifyWebhook } = require('./verifyWebhook');
const { findSdsItems } = require('./sds');
const { initSendGrid, sendSdsEmail } = require('./email');
const { JsonStore } = require('./store');
const { getAdminAccessToken } = require('./auth');

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
 * orders/paid webhook
 *
 * IMPORTANT: express.raw() must be registered BEFORE any body-parsing
 * middleware so `req.body` is the exact raw bytes Shopify signed — HMAC
 * verification requires the unparsed body.
 */
app.post(
  '/webhooks/orders/paid',
  express.raw({ type: '*/*' }),
  async (req, res) => {
    const hmac = req.get('X-Shopify-Hmac-SHA256') || '';
    const shop = req.get('X-Shopify-Shop-Domain') || '';
    const topic = req.get('X-Shopify-Topic') || '';
    const webhookId = req.get('X-Shopify-Webhook-Id') || '';

    if (topic !== 'orders/paid') {
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
      // 2.5 Get a valid Admin API access token (auto-refreshed client-credentials grant)
      const accessToken = await getAdminAccessToken();

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
);

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SDS emailer listening on port ${PORT}`);
});
