const { shopifyGraphQL } = require('./shopify');

const DEFAULT_CATEGORIES = [
  'Chemicals',
  'Odour Control',
  'Eco Friendly Chemicals',
  'Hand Sanitiser',
  'Hand Soap',
  'Hand Wipes',
];

/**
 * Categories come from the SDS_CATEGORIES env var (comma-separated);
 * defaults to the six categories specified for Central Cleaning Supplies.
 */
function getCategoryList() {
  const raw = process.env.SDS_CATEGORIES || DEFAULT_CATEGORIES.join(',');
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * A product qualifies when ANY of its Product Type or collection titles
 * matches one of the configured categories (case-insensitive exact match).
 */
function matchesCategory(product, categoryList) {
  const haystack = new Set(
    [product.productType, ...(product.collections || [])]
      .filter(Boolean)
      .map((s) => String(s).trim().toLowerCase())
  );
  return categoryList.some((c) => haystack.has(c));
}

/**
 * Resolve the SDS document URL from the custom.download_pdf_file metafield.
 *
 * The metafield can be one of two types:
 *  - type "url":           value is the URL itself
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
    return refUrl || null;
  }

  // type "url", or any metafield whose value is a plain URL
  if (/^https?:\/\//i.test(value)) return value;

  return null;
}

/**
 * Fetches product details (type, collections, SDS metafield) for a set of
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
          metafield(namespace: "custom", key: "download_pdf_file") {
            value
            type
            reference {
              ... on GenericFile {
                url
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
      collections: (node.collections?.edges || []).map((e) => e.node.title),
      metafield: node.metafield,
    }));
}

/**
 * Core business logic.
 *
 * Given an order's line items, returns one row per UNIQUE qualifying product:
 *  - the product must be in an applicable SDS category (product type or
 *    collection title), AND
 *  - custom.download_pdf_file must contain a resolvable URL.
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
    if (!product) continue; // product deleted or inaccessible

    seen.add(li.productId);

    const sdsUrl = resolveSdsUrl(product.metafield);
    if (!sdsUrl) continue; // no SDS document linked

    if (!matchesCategory(product, categories)) continue; // not an applicable category

    items.push({
      productName: product.title || li.title || 'Product',
      sku: String(li.sku || '').trim(),
      sdsUrl,
    });
  }

  return items;
}

module.exports = { findSdsItems, getCategoryList, matchesCategory, resolveSdsUrl, DEFAULT_CATEGORIES };
