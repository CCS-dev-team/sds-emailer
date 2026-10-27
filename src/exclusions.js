const { shopifyGraphQL } = require('./shopify');

/**
 * Metafield-driven opt-out for SDS emails.
 *
 * Two levels, checked in this order:
 *   1. COMPANY  — one flag on the B2B Company covers EVERY location and EVERY
 *                 contact under it (existing and future). Requires read_companies
 *                 (or read_customers) and only exists on B2B stores.
 *   2. CUSTOMER — one flag on the Customer covers that buyer only. Works on any
 *                 store. Requires read_customers.
 *
 * To exempt someone: tick the metafield in Shopify admin. No redeploy, no env
 * change, no code change.
 *
 * FAIL-OPEN: any Shopify/API error logs a warning and SENDS the email. Supplying
 * SDS documents is the compliance default; a transient API error must never
 * silently withhold them. Flip to fail-closed only if you prefer the reverse.
 *
 * INDIVIDUAL CUSTOMERS: a private (non-B2B) customer has NO company and NO
 * opt-out metafield at all. That is a "send" state, and it must never cost the
 * order a wasted B2B round trip — see companyLookupUnsupported below.
 */

function getOptOutKey() {
  const raw = process.env.SDS_OPT_OUT_METAFIELD || 'custom.sds_email_opt_out';
  const [namespace, ...rest] = raw.split('.');
  return {
    namespace: (namespace || 'custom').trim(),
    key: (rest.join('.') || 'sds_email_opt_out').trim(),
  };
}

function companyCheckEnabled() {
  return String(process.env.SDS_COMPANY_OPT_OUT || 'true').trim().toLowerCase() !== 'false';
}

function toOrderGid(order) {
  const raw = String((order && order.id) != null ? order.id : '').trim();
  if (!raw) return null;
  if (raw.startsWith('gid://')) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `gid://shopify/Order/${digits}` : null;
}

function toCustomerGid(order) {
  const raw = order && order.customer && order.customer.id ? String(order.customer.id) : '';
  if (!raw) return null;
  if (raw.startsWith('gid://')) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits ? `gid://shopify/Customer/${digits}` : null;
}

// "true"/"yes"/"1" = opted out of everything. A comma/semicolon list is also
// accepted so future email types can be excluded selectively, e.g. "sds,msds".
const TRUTHY = new Set(['true', 'yes', 'y', '1', 'on']);
const SCOPE_TOKENS = new Set(['sds', 'all', 'every']);

function isOptOutValue(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return false;
  if (TRUTHY.has(raw)) return true;
  return raw
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .some((v) => SCOPE_TOKENS.has(v));
}

function metafieldNodes(connection) {
  if (!connection) return [];
  if (Array.isArray(connection.nodes)) return connection.nodes;
  if (Array.isArray(connection.edges)) return connection.edges.map((e) => e && e.node);
  return [];
}

function findOptOutMetafield(connection, key) {
  const wantNs = key.namespace.toLowerCase();
  const wantKey = key.key.toLowerCase();
  return (
    metafieldNodes(connection).find(
      (m) =>
        m &&
        String(m.namespace || '').trim().toLowerCase() === wantNs &&
        String(m.key || '').trim().toLowerCase() === wantKey
    ) || null
  );
}

const CUSTOMER_QUERY = `
  query SdsOptOutCustomer($id: ID!, $namespace: String!) {
    customer(id: $id) {
      id
      displayName
      email
      metafields(first: 25, namespace: $namespace) {
        nodes { namespace key value type }
      }
    }
  }
`;

const COMPANY_QUERY = `
  query SdsOptOutCompany($id: ID!, $namespace: String!) {
    order(id: $id) {
      id
      name
      purchasingEntity {
        __typename
        ... on PurchasingCompany {
          company {
            id
            name
            metafields(first: 25, namespace: $namespace) {
              nodes { namespace key value type }
            }
          }
          location { id name }
        }
      }
    }
  }
`;

// Small in-process cache: a company placing many orders, or one order firing
// both orders/paid and orders/fulfilled, should not re-query every time.
const cache = new Map();
const CACHE_TTL_MS = Number(process.env.SDS_EXCLUSION_CACHE_MS || 5 * 60 * 1000);

// Learned once per process: can this store answer the B2B company question at
// all? An individual (non-B2B) customer has NO company and NO opt-out
// metafield, so a failing/absent company lookup must never cost every order a
// wasted round trip inside Shopify's ~5s webhook budget. Always fail-open.
let companyLookupUnsupported = false;

function resetCompanyLookupSupport() {
  companyLookupUnsupported = false;
}

function cacheGet(cacheKey) {
  const hit = cache.get(cacheKey);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(cacheKey);
    return undefined;
  }
  return hit.value;
}

function cacheSet(cacheKey, value) {
  cache.set(cacheKey, { at: Date.now(), value });
}

async function checkCustomerOrigin(shop, accessToken, order, key) {
  const gid = toCustomerGid(order);
  if (!gid) return { excluded: false };

  const cacheKey = `customer:${gid}`;
  const cachedResult = cacheGet(cacheKey);
  if (cachedResult) return cachedResult;

  let out;
  try {
    const data = await shopifyGraphQL(shop, accessToken, CUSTOMER_QUERY, {
      id: gid,
      namespace: key.namespace,
    });
    const customer = data && data.customer;
    if (!customer) {
      out = { excluded: false, reason: 'customer not found' };
    } else {
      const mf = findOptOutMetafield(customer.metafields, key);
      out =
        mf && isOptOutValue(mf.value)
          ? {
              excluded: true,
              scope: 'customer',
              id: customer.id,
              name: customer.displayName || customer.email || customer.id,
            }
          : { excluded: false };
    }
  } catch (err) {
    console.warn(`[exclusions] customer lookup failed for ${gid}; sending anyway:`, err.message);
    out = { excluded: false, reason: 'customer lookup failed (fail-open)' };
  }

  cacheSet(cacheKey, out);
  return out;
}

async function checkCompanyOrigin(shop, accessToken, order, key) {
  const orderGid = toOrderGid(order);
  if (!orderGid) return { excluded: false };

  if (companyLookupUnsupported) {
    return { excluded: false, reason: 'company lookup unsupported (not B2B) - skipped' };
  }

  const cacheKey = `order-company:${orderGid}`;
  const cachedResult = cacheGet(cacheKey);
  if (cachedResult) return cachedResult;

  let out;
  try {
    const data = await shopifyGraphQL(shop, accessToken, COMPANY_QUERY, {
      id: orderGid,
      namespace: key.namespace,
    });
    const entity = data && data.order && data.order.purchasingEntity;
    const company = entity && entity.company;
    if (!company || !company.id) {
      out = { excluded: false, reason: 'order has no company (individual customer)' };
    } else {
      const mf = findOptOutMetafield(company.metafields, key);
      out =
        mf && isOptOutValue(mf.value)
          ? {
              excluded: true,
              scope: 'company',
              id: company.id,
              name: company.name || company.id,
            }
          : { excluded: false, companyId: company.id, companyName: company.name };
    }
  } catch (err) {
    console.warn(`[exclusions] company lookup failed for order ${orderGid}; sending anyway:`, err.message);
    // Latch ONLY on a permanent capability failure: the field does not exist on
    // this store (no B2B) or is not readable at all. A transient network blip or
    // a per-order hiccup must never disable company opt-out for the process.
    const msg = String((err && err.message) || '');
    if (/purchasingentity[^\n]*(doesn'?t|does not) exist|field 'purchasingentity'/i.test(msg)) {
      companyLookupUnsupported = true;
      console.warn('[exclusions] store cannot answer the company lookup; skipping it for later orders (fail-open)');
    }
    out = { excluded: false, reason: 'company lookup failed (fail-open)' };
  }

  cacheSet(cacheKey, out);
  return out;
}

/**
 * Decide whether this order should receive the SDS email.
 *
 * @returns {Promise<{excluded: boolean, scope?: string, id?: string, name?: string,
 *                    reason?: string, companyReason?: string, metafield: string}>}
 */
async function checkExclusions(shop, accessToken, order) {
  const key = getOptOutKey();
  const metafield = `${key.namespace}.${key.key}`;

  let companyResult = { excluded: false, reason: 'company check disabled (SDS_COMPANY_OPT_OUT=false)' };

  if (companyCheckEnabled()) {
    companyResult = await checkCompanyOrigin(shop, accessToken, order, key);
    if (companyResult.excluded) {
      return { ...companyResult, metafield, companyReason: companyResult.reason };
    }
  }

  const customerResult = await checkCustomerOrigin(shop, accessToken, order, key);
  if (customerResult.excluded) {
    return { ...customerResult, metafield, companyReason: companyResult.reason };
  }

  return {
    excluded: false,
    metafield,
    companyReason: companyResult.reason,
    reason: customerResult.reason || 'no opt-out metafield set',
  };
}

function clearExclusionCache() {
  cache.clear();
}

module.exports = {
  checkExclusions,
  isOptOutValue,
  findOptOutMetafield,
  getOptOutKey,
  clearExclusionCache,
  resetCompanyLookupSupport,
};
