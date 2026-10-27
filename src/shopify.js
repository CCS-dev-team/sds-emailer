const ADMIN_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';

/**
 * Hard cap on a single Admin API round trip, in milliseconds.
 *
 * Shopify abandons a webhook delivery after roughly 5 s, so a request that hangs
 * must fail fast and loudly instead of eating the whole webhook budget and losing
 * the order with no log line. The live webhook path makes several sequential
 * Admin API calls (company opt-out, customer opt-out, product lookup), so each
 * one is capped rather than the total.
 *
 * Override with SHOPIFY_TIMEOUT_MS when a query legitimately needs longer, e.g. a
 * full-catalog audit or a slow cold start. Read once at module load, like
 * ADMIN_API_VERSION.
 */
const DEFAULT_TIMEOUT_MS = 4000;
const configuredTimeout = Number(process.env.SHOPIFY_TIMEOUT_MS);
const REQUEST_TIMEOUT_MS =
  Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_TIMEOUT_MS;

/**
 * True when an error was produced by our AbortController firing.
 *
 * Node's fetch throws a DOMException named "AbortError" when the request itself is
 * aborted, but when the abort lands mid-body it surfaces as a TypeError
 * ("terminated") whose `cause` is the AbortError, or as code ABORT_ERR. All three
 * shapes are treated as a timeout.
 */
function isAbortError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  if (err.code === 'ABORT_ERR') return true;
  if (err.cause && err.cause.name === 'AbortError') return true;
  return false;
}

/**
 * Minimal Shopify Admin GraphQL client using Node's built-in fetch (Node >= 18).
 *
 * The fetch and the response body read share one 4 s (default) AbortController.
 * The timer is cleared in `finally`, so a stalled body cannot leak a live timer
 * into the next call. On expiry the error message names the shop, the API
 * version and the limit, which keeps the cause obvious in Render logs.
 *
 * @param {string} shop         Store domain, e.g. "store.myshopify.com"
 * @param {string} accessToken  Admin API access token
 * @param {string} query        GraphQL query
 * @param {object} variables    GraphQL variables
 * @returns {Promise<object>}   response data
 * @throws {Error}              on timeout, non-2xx HTTP, or GraphQL errors
 */
async function shopifyGraphQL(shop, accessToken, query, variables = {}) {
  const url = `https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // Do not let a pending timeout keep the process alive at shutdown.
  if (typeof timer.unref === 'function') timer.unref();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    // The body read sits inside the guarded block: a response can arrive in time
    // while its body stalls, and that must abort too. res.json() is the original
    // behaviour, kept so existing callers and test stubs are unaffected.
    const body = await res.json();

    if (!res.ok || body.errors) {
      throw new Error(
        `Shopify GraphQL request failed (${res.status}): ${JSON.stringify(body.errors || body)}`
      );
    }

    return body.data;
  } catch (err) {
    if (isAbortError(err)) {
      throw new Error(
        `Shopify GraphQL request timed out after ${REQUEST_TIMEOUT_MS}ms ` +
          `(${shop}, API ${ADMIN_API_VERSION}). Raise SHOPIFY_TIMEOUT_MS if this ` +
          `query legitimately needs longer.`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { shopifyGraphQL, ADMIN_API_VERSION };
