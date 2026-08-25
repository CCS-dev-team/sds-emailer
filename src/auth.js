/**
 * Access-token management for Dev-Dashboard apps.
 *
 * Since January 1, 2026, new custom apps are created exclusively in the
 * Shopify Dev Dashboard, which does NOT hand out a long-lived Admin API
 * access token. The documented way for such an app to act on stores in its
 * own organization is the "client credentials" grant: the app exchanges its
 * client ID and client secret for a store access token directly.
 *
 * Tokens from this grant are short-lived (24 hours by default), so this
 * module caches the token in memory and automatically requests a fresh one
 * a few minutes before the current one expires — no user interaction, no
 * manual refresh.
 *
 * Backwards compatibility: if a legacy long-lived
 * SHOPIFY_ADMIN_ACCESS_TOKEN is present in .env, it takes priority and no
 * client-credentials call is made.
 */

let cachedToken = null;
let cachedExpiresAt = 0;

async function obtainClientCredentialsToken(shop, clientId, clientSecret) {
  const url = `https://${shop}/admin/oauth/access_token`;

  // ---- TEMPORARY DIAGNOSTICS (remove once the grant works) ----
  console.log('[auth] POST', url);
  const id = String(clientId || '');
  const secret = String(clientSecret || '');
  console.log(
    `[auth] shop="${shop}" (length ${shop.length}) | ` +
      `contains https? ${/https?:\/\//i.test(shop)} | trailing slash? ${/\/$/.test(shop)}`
  );
  console.log(
    `[auth] client_id prefix="${id.slice(0, 4)}..." (length ${id.length}) | ` +
      `client_secret prefix="${secret.slice(0, 4)}..." (length ${secret.length})`
  );
  // -------------------------------------------------------------

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  // The response body may not be JSON on failure — parse defensively and
  // surface the raw text; Shopify often returns an EMPTY body on 400 and
  // puts the reason in status/headers instead.
  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = rawText ? { raw: rawText } : {};
  }

  if (!res.ok || !data.access_token) {
    console.error('[auth] GRANT FAILED — status', res.status);
    console.error(
      '[auth] response headers:',
      JSON.stringify(Object.fromEntries(res.headers.entries()), null, 2)
    );
    throw new Error(
      `Client credentials grant failed (HTTP ${res.status}): ${rawText || '(empty body)'}`
    );
  }

  // Shopify returns expires_in in seconds (typically 86400 = 24h).
  // Refresh ~5 minutes early so in-flight webhooks never hit a dead token.
  const expiresInSeconds = Number(data.expires_in) || 86400;

  cachedToken = data.access_token;
  cachedExpiresAt = Date.now() + (expiresInSeconds - 300) * 1000;

  console.log(
    `[auth] Obtained Admin API access token for ${shop} ` +
      `(expires in ${expiresInSeconds}s, cached until ${new Date(cachedExpiresAt).toISOString()})`
  );

  return cachedToken;
}

/**
 * Returns a valid Admin API access token for the configured shop.
 * - Legacy explicit token (SHOPIFY_ADMIN_ACCESS_TOKEN) wins if set.
 * - Otherwise performs/refreshes the client-credentials grant using
 *   SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET.
 */
async function getAdminAccessToken() {
  if (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN) {
    return process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  }

  if (cachedToken && Date.now() < cachedExpiresAt) {
    return cachedToken;
  }

  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'No Admin API access available: set SHOPIFY_CLIENT_ID and ' +
        'SHOPIFY_CLIENT_SECRET (Dev Dashboard app) so the app can request a ' +
        'token via the client credentials grant, or set a legacy ' +
        'SHOPIFY_ADMIN_ACCESS_TOKEN.'
    );
  }

  return obtainClientCredentialsToken(shop, clientId, clientSecret);
}

module.exports = { getAdminAccessToken };
