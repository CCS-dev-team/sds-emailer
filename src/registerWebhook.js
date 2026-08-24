/**
 * One-off script: register the ORDERS_PAID webhook subscription on your store.
 *
 *   node src/registerWebhook.js
 *
 * Requires in .env:
 *   SHOPIFY_SHOP_DOMAIN, SHOPIFY_ADMIN_ACCESS_TOKEN, WEBHOOK_CALLBACK_URL
 */
require('dotenv').config();

const { getAdminAccessToken } = require('./auth');

const shop = process.env.SHOPIFY_SHOP_DOMAIN;
const callbackUrl = process.env.WEBHOOK_CALLBACK_URL;
const version = process.env.SHOPIFY_API_VERSION || '2026-07';

if (!shop || !callbackUrl) {
  console.error('Missing SHOPIFY_SHOP_DOMAIN or WEBHOOK_CALLBACK_URL in .env');
  process.exit(1);
}

if (!/^https:\/\//i.test(callbackUrl)) {
  console.error('WEBHOOK_CALLBACK_URL must be an HTTPS URL.');
  process.exit(1);
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
        apiVersion
      }
      userErrors {
        field
        message
      }
    }
  }
`;

async function main() {
  // Client-credentials grant (Dev Dashboard) or legacy token — either way,
  // auth.js returns a valid Admin API access token.
  const adminToken = await getAdminAccessToken();

  const res = await fetch(`https://${shop}/admin/api/${version}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': adminToken,
    },
    body: JSON.stringify({
      query,
      variables: { topic: 'ORDERS_PAID', callbackUrl },
    }),
  });

  const body = await res.json();

  const errors =
    body.errors ||
    body.data?.webhookSubscriptionCreate?.userErrors ||
    [];

  if (errors.length || !res.ok) {
    console.error('Webhook registration failed:', JSON.stringify(errors, null, 2));
    process.exit(1);
  }

  console.log(
    'Webhook registered:',
    JSON.stringify(body.data.webhookSubscriptionCreate.webhookSubscription, null, 2)
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
