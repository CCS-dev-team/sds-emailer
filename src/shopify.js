const ADMIN_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';

/**
 * Minimal Shopify Admin GraphQL client using Node's built-in fetch (Node >= 18).
 *
 * @param {string} shop         Store domain, e.g. "store.myshopify.com"
 * @param {string} accessToken  Admin API access token
 * @param {string} query        GraphQL query
 * @param {object} variables    GraphQL variables
 * @returns {Promise<object>}   response data
 */
async function shopifyGraphQL(shop, accessToken, query, variables = {}) {
  const url = `https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = await res.json();

  if (!res.ok || body.errors) {
    throw new Error(
      `Shopify GraphQL request failed (${res.status}): ${JSON.stringify(body.errors || body)}`
    );
  }

  return body.data;
}

module.exports = { shopifyGraphQL, ADMIN_API_VERSION };
