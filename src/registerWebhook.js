/**
 * One-off script: register the webhook subscriptions on your store.
 *
 *   node src/registerWebhook.js
 *
 * Subscribes to:
 *   ORDERS_PAID      - fires when payment is captured (paid-upfront orders)
 *   ORDERS_FULFILLED - fires when the order is fulfilled / goods dispatched.
 *                      Essential for Net-term orders: ORDERS_PAID does not
 *                      fire until the customer actually settles (30+ days),
 *                      so fulfilment is the trigger that emails the SDS when
 *                      the customer starts handling the chemicals.
 *
 * Requires in .env:
 *   SHOPIFY_SHOP_DOMAIN, WEBHOOK_CALLBACK_URL, and valid auth (client
 *   credentials grant or SHOPIFY_ADMIN_ACCESS_TOKEN).
 */
require('dotenv').config();

const { getAdminAccessToken } = require('./auth');

const shop = process.env.SHOPIFY_SHOP_DOMAIN;
const version = process.env.SHOPIFY_API_VERSION || '2026-07';

/**
 * Each topic is delivered to its OWN path on the same origin. The handler keys
 * off the X-Shopify-Topic header, so a shared URL still works, but matching
 * paths keep Shopify's UI and the Render logs readable - and previously a single
 * ORDERS_FULFILLED subscription was created pointing at /webhooks/orders/paid.
 *
 * Only the ORIGIN of WEBHOOK_CALLBACK_URL is used, so an existing
 * .../webhooks/orders/paid value keeps working unchanged.
 */
const TOPIC_PATHS = {
  ORDERS_PAID: '/webhooks/orders/paid',
  ORDERS_FULFILLED: '/webhooks/orders/fulfilled',
};

const TOPICS = Object.keys(TOPIC_PATHS);

/** Build the per-topic callback URL from the origin of WEBHOOK_CALLBACK_URL. */
function callbackUrlFor(topic) {
  const base = process.env.WEBHOOK_CALLBACK_URL;
  if (!base) throw new Error('WEBHOOK_CALLBACK_URL is missing from .env');
  const origin = new URL(base).origin;
  return `${origin}${TOPIC_PATHS[topic]}`;
}

const query = `
  mutation WebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $callbackUrl: URL!) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: { callbackUrl: $callbackUrl }
    ) {
      webhookSubscription {
        id
        topic
        callbackUrl
        format
        apiVersion {
          handle
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

async function registerOne(adminToken, topic) {
  const callbackUrl = callbackUrlFor(topic);
  const res = await fetch(`https://${shop}/admin/api/${version}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': adminToken,
    },
    body: JSON.stringify({
      query,
      variables: { topic, callbackUrl },
    }),
  });

  const body = await res.json();
  const errors = body.errors || body.data?.webhookSubscriptionCreate?.userErrors || [];

  if (errors.length || !res.ok) {
    return { topic, ok: false, errors };
  }

  return {
    topic,
    ok: true,
    subscription: body.data.webhookSubscriptionCreate.webhookSubscription,
  };
}

(async () => {
  const base = process.env.WEBHOOK_CALLBACK_URL;

  if (!shop || !base) {
    console.error('Missing SHOPIFY_SHOP_DOMAIN or WEBHOOK_CALLBACK_URL in .env');
    process.exitCode = 1;
    return;
  }

  if (!/^https:\/\//i.test(base)) {
    console.error('WEBHOOK_CALLBACK_URL must be an HTTPS URL.');
    process.exitCode = 1;
    return;
  }

  console.log(`Shop:   ${shop}`);
  console.log(`Auth:   ${process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ? 'explicit SHOPIFY_ADMIN_ACCESS_TOKEN' : 'client-credentials grant'}`);
  for (const t of TOPICS) console.log(`Target: ${t} -> ${callbackUrlFor(t)}`);
  console.log('');

  try {
    // OAuth access token (production store) or client-credentials grant —
    // either way, auth.js returns a valid Admin API access token.
    const adminToken = await getAdminAccessToken();

    const results = await Promise.all(TOPICS.map((topic) => registerOne(adminToken, topic)));

    let failed = false;
    for (const r of results) {
      if (r.ok) {
        console.log(`Webhook registered (${r.topic}):`, JSON.stringify(r.subscription, null, 2));
      } else {
        failed = true;
        console.error(`Webhook registration failed (${r.topic}):`, JSON.stringify(r.errors, null, 2));
      }
    }
    if (failed) process.exitCode = 1;
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
})();
