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
const callbackUrl = process.env.WEBHOOK_CALLBACK_URL;
const version = process.env.SHOPIFY_API_VERSION || '2026-07';

const TOPICS = ['ORDERS_PAID', 'ORDERS_FULFILLED'];

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
  if (!shop || !callbackUrl) {
    console.error('Missing SHOPIFY_SHOP_DOMAIN or WEBHOOK_CALLBACK_URL in .env');
    process.exitCode = 1;
    return;
  }

  if (!/^https:\/\//i.test(callbackUrl)) {
    console.error('WEBHOOK_CALLBACK_URL must be an HTTPS URL.');
    process.exitCode = 1;
    return;
  }

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
