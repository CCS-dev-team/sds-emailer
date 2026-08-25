/**
 * OAuth authorization code grant (standalone apps).
 *
 * Used to install the app on a store that is NOT in the same Dev Dashboard
 * organization as the app (e.g. a production store) — the client-credentials
 * grant is refused with 400 "shop_not_permitted" in that case.
 *
 * Flow (run once, locally):
 *   1. Open  http://localhost:3000/auth/install  -> redirects to Shopify
 *   2. Approve the app on the store
 *   3. Shopify redirects to  /auth/callback?code=...&shop=...&state=...&hmac=...
 *   4. We validate state + shop + HMAC, exchange the code for an offline
 *      access token, print it, and save it to data/shopify-token.json
 *   5. Paste the token into SHOPIFY_ADMIN_ACCESS_TOKEN (.env + Render)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'data', 'oauth-state.json');
const TOKEN_FILE = path.join(__dirname, '..', 'data', 'shopify-token.json');

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ state, createdAt: Date.now() }));
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).state;
  } catch {
    return null;
  }
}

/**
 * Build the authorization URL (RFC 6749 authorization code grant).
 * The redirect_uri must EXACTLY match an allowed redirect URL configured in
 * the Dev Dashboard version.
 */
function buildInstallUrl(shop, clientId, redirectUri) {
  const state = crypto.randomBytes(16).toString('hex');
  saveState(state);
  const params = new URLSearchParams({
    client_id: clientId,
    scope: 'read_orders,read_products',
    redirect_uri: redirectUri,
    state,
  });
  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}

/**
 * Validate the OAuth callback exactly as Shopify's standalone-app docs
 * require: shop matches ^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$,
 * state equals our stored nonce, and hmac (HMAC-SHA256 of the sorted query
 * params minus hmac/signature) verifies with the client secret.
 */
function verifyCallback(query, clientSecret) {
  const shop = query.shop || '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)) {
    return { ok: false, error: 'Invalid shop parameter' };
  }

  const storedState = loadState();
  if (!storedState || query.state !== storedState) {
    return { ok: false, error: 'state mismatch (missed or replayed request)' };
  }

  const hmacHeader = query.hmac || '';
  const message = Object.keys(query)
    .filter((k) => k !== 'hmac' && k !== 'signature')
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join('&');

  const expected = crypto.createHmac('sha256', clientSecret).update(message).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(hmacHeader);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return { ok: false, error: 'HMAC validation failed' };

  return { ok: true, shop };
}

/** Exchange the authorization code for an offline access token. */
async function exchangeCode(shop, clientId, clientSecret, code, redirectUri) {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.access_token) {
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${JSON.stringify(data)}`);
  }

  return data;
}

/** Persist the token response and return the file path. */
function saveToken(data) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(
    TOKEN_FILE,
    JSON.stringify({ ...data, savedAt: new Date().toISOString() }, null, 2)
  );
  return TOKEN_FILE;
}

module.exports = { buildInstallUrl, verifyCallback, exchangeCode, saveToken };
