/**
 * Send a correctly HMAC-signed Shopify-shaped webhook to the deployed app.
 *
 * This is the only way to exercise the REAL webhook path end to end without
 * creating a Shopify order. It signs the raw body with the same secret the
 * server verifies with (SHOPIFY_API_SECRET, falling back to
 * SHOPIFY_CLIENT_SECRET - exactly like src/server.js:21), so it gets past the
 * 401 and runs the full pipeline: opt-out -> product lookup -> SendGrid.
 *
 * It WILL send a real email, so always pass a test address.
 *
 * Usage:
 *   node test\send-signed-webhook.js https://sds-emailer.onrender.com/webhooks/orders/fulfilled you@example.com
 */
const path = require('node:path');
const crypto = require('node:crypto');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const ENDPOINT = process.argv[2] || 'https://sds-emailer.onrender.com/webhooks/orders/fulfilled';
const TO = process.argv[3];

function topicFor(u) {
  return u.includes('/fulfilled') ? 'orders/fulfilled' : 'orders/paid';
}

async function main() {
  if (!TO || !TO.includes('@')) {
    console.error('Usage: node test\\send-signed-webhook.js <endpoint-url> <test-email>');
    console.error('  e.g. node test\\send-signed-webhook.js https://sds-emailer.onrender.com/webhooks/orders/fulfilled you@example.com');
    process.exitCode = 1;
    return;
  }

  const secret = process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_CLIENT_SECRET;
  if (!secret) throw new Error('Neither SHOPIFY_API_SECRET nor SHOPIFY_CLIENT_SECRET is set in .env');
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  if (!shop) throw new Error('SHOPIFY_SHOP_DOMAIN is missing from .env');

  // Shopify "orders/fulfilled" payload, reduced to the fields the handler reads
  // (src/server.js:124-128 and :142-149). product_id is a REAL product with an
  // SDS metafield, so findSdsItems() resolves a row and the email really sends.
  // A fresh id per run keeps the idempotency ledger from skipping a repeat test.
  const orderId = Date.now();
  const order = {
    id: orderId,
    name: `TESTSIGNED-${orderId}`,
    email: TO,
    customer: { first_name: 'Signed', last_name: 'Test' },
    line_items: [
      {
        title: 'Enzyme Wizard No Rinse Floor Cleaner 1L',
        sku: 'CEFC1L2',
        quantity: 1,
        product_id: 7832278106251,
      },
    ],
  };

  const body = JSON.stringify(order);
  const hmac = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');
  const topic = topicFor(ENDPOINT);

  console.log(`POST    ${ENDPOINT}`);
  console.log(`topic   ${topic}`);
  console.log(`shop    ${shop}`);
  console.log(`to      ${TO}`);
  console.log(`order   ${orderId}`);
  console.log(`hmac    ${hmac.slice(0, 12)}... (len ${hmac.length})`);
  console.log('');

  const t0 = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-SHA256': hmac,
      'X-Shopify-Topic': topic,
      'X-Shopify-Shop-Domain': shop,
      'X-Shopify-Webhook-Id': crypto.randomUUID(),
      'X-Shopify-Event-Id': crypto.randomUUID(),
    },
    body,
  });

  const text = await res.text();
  console.log(`HTTP ${res.status} in ${Date.now() - t0}ms`);
  console.log(text || '(empty body)');
  console.log('');

  if (res.status === 401) {
    console.log('401 - the app rejected the signature. Your LOCAL secret differs from');
    console.log('      the one in Render. Compare them, then allow up to an hour after');
    console.log('      any rotation before Shopify signs with the new value.');
  } else if (res.status === 200 && /"emailsSent":1/.test(text)) {
    console.log('SUCCESS - the app took the delivery and sent the email.');
    console.log('Check the inbox, then the Render log for:');
    console.log('  [webhook] SDS email sent for order ...');
  } else if (res.status === 200) {
    console.log('200 but no email - a gate skipped it. Read the Render log line just');
    console.log('before the response: [webhook] No SDS items / no customer email /');
    console.log('already emailed / opted out.');
  } else {
    console.log('Unexpected status - check the Render log for [webhook] Processing failed.');
  }
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
});
