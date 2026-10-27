const { shopifyGraphQL } = require('./shopify');

const DEFAULT_CATEGORIES = [
  'Chemicals',
  'Cleaning Chemicals',
  'Odour Control',
  'Odor Control',
  'Eco Friendly Chemicals',
  'Hand Sanitiser',
  'Hand Soap',
  'Hand Wipes',
  'Insect Repellants',
  'Spill Kit',
  'Cleaners & Degreasers',
  'Surface Disinfectants & Sanitisers',
];

/**
 * Categories come from the SDS_CATEGORIES env var (comma-separated);
 * defaults to the twelve confirmed categories for Central Cleaning Supplies.
 */
function getCategoryList() {
  const raw = process.env.SDS_CATEGORIES || DEFAULT_CATEGORIES.join(',');
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function normalize(s) {
  return String(s || '').trim().toLowerCase();
}

/**
 * A product qualifies when ANY of its Product Type, collection titles, or
 * tags EXACTLY matches one of the configured categories. Matching is
 * case-insensitive and whitespace-trimmed, but NOT substring-based:
 *   "Cleaning Chemicals" matches "Cleaning Chemicals" only
 *   "Hand Sanitiser Gel" does NOT match "Hand Sanitiser"
 * (Exact matching was locked in so partial-name tags such as "Soap" or
 * "Hand Sanitiser Gel" cannot accidentally flag a product.)
 */
function matchesCategory(product, categoryList) {
  const haystacks = [
    product.productType,
    ...(product.collections || []),
    ...(product.tags || []),
  ]
    .filter(Boolean)
    .map(normalize);

  if (!haystacks.length) return false;

  return categoryList.some((c) => {
    if (!c) return false;
    return haystacks.includes(c);
  });
}

/**
 * Resolve the SDS document URL from a metafield.
 *
 * The metafield can be one of two types:
 *  - type "url":            value is the URL itself
 *  - type "file_reference": value is a GID; the file's real URL is on
 *                            reference { ... on GenericFile { url } }
 *
 * Returns null when the metafield is missing or empty.
 */
function resolveSdsUrl(metafield) {
  if (!metafield) return null;

  const value = String(metafield.value || '').trim();

  if (metafield.type === 'file_reference') {
    const ref = metafield.reference;
    const refUrl = ref && ref.url ? String(ref.url).trim() : '';
    if (refUrl) return refUrl;
  }

  // type "url", or any metafield whose value is a plain URL.
  // NOTE: rich_text_field values are JSON payloads, never URLs, so they
  // naturally fail the http(s) check below and can never be mistaken for an
  // SDS link (verified against the real TAU5 fixture in the unit tests).
  if (/^https?:\/\//i.test(value)) return value;

  return null;
}

/**
 * Find the SDS metafield among a product's metafields, in priority order:
 *   1. exactly  custom.download_pdf_file  (the identifier CCS specified)
 *   2. any custom-namespace key containing "download" / "pdf"
 *   3. any key (any namespace) containing "download_pdf" or "sds"
 * Returns null when nothing looks like an SDS document link.
 */
function findSdsMetafield(metafields) {
  if (!Array.isArray(metafields) || !metafields.length) return null;

  const exact = metafields.find(
    (m) => m && m.namespace === 'custom' && normalize(m.key) === 'download_pdf_file'
  );
  if (exact) return exact;

  return (
    metafields.find((m) => {
      if (!m) return false;
      const key = normalize(m.key);
      const ns = normalize(m.namespace);
      if (key.includes('download_pdf') || key.includes('sds')) return true;
      if (ns === 'custom' && (key.includes('download') || key.includes('pdf'))) return true;
      return false;
    }) || null
  );
}

/**
 * Fetches product details (type, tags, collections, metafields) for a set of
 * product GIDs using a single batched GraphQL query.
 */
async function fetchProductInfo(shop, accessToken, productGids) {
  if (!productGids.length) return [];

  const query = `
    query SdsProducts($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          title
          productType
          tags
          metafield(namespace: "custom", key: "download_pdf_file") {
            namespace
            key
            value
            type
            reference {
              ... on GenericFile {
                url
              }
            }
          }
          metafields(first: 60) {
            edges {
              node {
                namespace
                key
                type
                value
                reference {
                  ... on GenericFile {
                    url
                  }
                }
              }
            }
          }
          collections(first: 25) {
            edges {
              node {
                title
              }
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(shop, accessToken, query, { ids: productGids });

  return (data.nodes || [])
    .filter(Boolean)
    .map((node) => ({
      id: node.id,
      title: node.title,
      productType: node.productType || '',
      tags: node.tags || [],
      collections: (node.collections?.edges || []).map((e) => e.node.title),
      metafield: node.metafield,
      metafields: (node.metafields?.edges || []).map((e) => e.node),
    }));
}

/**
 * Decide whether a single product qualifies for an SDS email row.
 *
 * Shared by findSdsItems and the unit-test suite, so the real catalogue
 * shape (e.g. the TAU5 fixture: empty productType, category carried by tags/
 * collections, SDS in custom.download_pdf_file type url) is validated
 * against the exact production logic.
 *
 * @returns {{productName: string, sku: string, sdsUrl: string} | null}
 */
function evaluateProduct(product, lineItem, categories) {
  const sdsMetafield = product.metafield || findSdsMetafield(product.metafields);
  const sdsUrl = resolveSdsUrl(sdsMetafield);
  const categoryMatch = matchesCategory(product, categories);

  console.log(
    `[sds] product "${product.title}" sku=${lineItem.sku || ''} ` +
      `type="${product.productType || ''}" ` +
      `collections=[${(product.collections || []).join(' | ')}] ` +
      `tags=[${(product.tags || []).join(' | ')}] ` +
      `metafield=${sdsMetafield ? `${sdsMetafield.namespace}.${sdsMetafield.key} (${sdsMetafield.type})` : 'none'} ` +
      `sdsUrl=${sdsUrl ? sdsUrl.slice(0, 100) : 'none'} ` +
      `categoryMatch=${categoryMatch}`
  );

  if (!sdsUrl) return null; // no SDS document linked
  if (!categoryMatch) return null; // not an applicable category

  return {
    productName: product.title || lineItem.title || 'Product',
    sku: String(lineItem.sku || '').trim(),
    sdsUrl,
  };
}

/**
 * Core business logic.
 *
 * Given an order's line items, returns one row per UNIQUE qualifying product:
 *  - the product must be in an applicable SDS category (product type,
 *    collection title, or tag), AND
 *  - an SDS metafield (custom.download_pdf_file preferred) must contain a
 *    resolvable URL.
 *
 * NOTE: webhook line-item payloads do NOT include product tags or metafields,
 * so this always looks the product up via the Admin API by product GID.
 *
 * Verbose per-product logging is intentional while the integration is being
 * validated — it shows exactly why a product was skipped.
 *
 * @returns {Promise<Array<{productName: string, sku: string, sdsUrl: string}>>}
 */
async function findSdsItems(shop, accessToken, order) {
  const productGids = [
    ...new Set(
      (order.lineItems || [])
        .map((li) => li.productId)
        .filter(Boolean)
    ),
  ];

  const [products, categories] = await Promise.all([
    fetchProductInfo(shop, accessToken, productGids),
    Promise.resolve(getCategoryList()),
  ]);

  const productById = new Map(products.map((p) => [p.id, p]));
  const seen = new Set();
  const items = [];

  for (const li of order.lineItems || []) {
    if (!li.productId || seen.has(li.productId)) continue;

    const product = productById.get(li.productId);
    if (!product) {
      console.log(`[sds] product not found for gid=${li.productId} (${li.title || ''})`);
      continue;
    }

    seen.add(li.productId);

    const item = evaluateProduct(product, li, categories);
    if (item) items.push(item);
  }

  return items;
}

module.exports = {
  findSdsItems,
  evaluateProduct,
  getCategoryList,
  matchesCategory,
  resolveSdsUrl,
  findSdsMetafield,
  DEFAULT_CATEGORIES,
};
