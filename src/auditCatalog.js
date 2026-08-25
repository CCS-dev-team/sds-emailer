/**
 * One-off AUDIT: which of your products have an SDS (custom.download_pdf_file
 * or a similar metafield) and would the CURRENT category matching let them
 * through?
 *
 *   node src/auditCatalog.js
 *
 * Prints:
 *   - catalog size, how many products carry an SDS URL
 *   - how many of those would pass the current category filter (emailed)
 *     vs. how many would be SKIPPED (missed emails)
 *   - the distinct product types / collection titles / tags among SKIPPED
 *     products (extend SDS_CATEGORIES in .env, or retag these products)
 *   - the distinct terms among MATCHED products (already covered)
 *   - the list of products that would currently receive NO email
 *
 * Uses the exact production logic (src/sds.js evaluateProduct), so what the
 * report says is precisely what the webhook handler would decide.
 * Read-only: it never creates, updates, or deletes anything.
 */
try { require('dotenv').config(); } catch (_) {}

const { getAdminAccessToken } = require('./auth');
const { shopifyGraphQL } = require('./shopify');
const {
  getCategoryList,
  matchesCategory,
  resolveSdsUrl,
  findSdsMetafield,
} = require('./sds');

const PER_PAGE = 100;

const QUERY = `
  query ProductsPage($cursor: String) {
    products(first: ${PER_PAGE}, after: $cursor, sortKey: TITLE) {
      edges {
        node {
          id
          title
          productType
          tags
          metafield(namespace: "custom", key: "download_pdf_file") {
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
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

function nodeToProduct(node) {
  return {
    id: node.id,
    title: node.title,
    productType: node.productType || '',
    tags: node.tags || [],
    collections: (node.collections?.edges || []).map((e) => e.node.title),
    metafield: node.metafield || null,
    metafields: (node.metafields?.edges || []).map((e) => e.node),
  };
}

async function fetchAllProducts(shop, token) {
  const products = [];
  let cursor = null;
  for (;;) {
    const data = await shopifyGraphQL(shop, token, QUERY, { cursor });
    const page = data.products;
    for (const edge of page.edges) products.push(nodeToProduct(edge.node));
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return products;
}

function bump(map, term) {
  const key = String(term || '').trim().toLowerCase();
  if (key) map.set(key, (map.get(key) || 0) + 1);
}

/**
 * Pure report logic (kept separate so it can be unit-tested).
 *
 * @param {Array<object>} products   Already-normalised products (nodeToProduct)
 * @param {Array<string>} categories Lower-cased category list
 * @returns {object} report
 */
function buildReport(products, categories) {
  const report = {
    total: products.length,
    withSds: 0,
    matchCount: 0,
    skipCount: 0,
    unmatchedTerms: { types: new Map(), collections: new Map(), tags: new Map() },
    matchedTerms: { types: new Map(), collections: new Map(), tags: new Map() },
    skipped: [],
  };

  for (const p of products) {
    const mf = p.metafield || findSdsMetafield(p.metafields);
    const hasSds = !!resolveSdsUrl(mf);
    if (!hasSds) continue;

    report.withSds += 1;

    const catMatch = matchesCategory(p, categories);
    const terms = catMatch ? report.matchedTerms : report.unmatchedTerms;

    if (p.productType) bump(terms.types, p.productType);
    for (const c of p.collections || []) bump(terms.collections, c);
    for (const t of p.tags || []) bump(terms.tags, t);

    if (catMatch) {
      report.matchCount += 1;
    } else {
      report.skipCount += 1;
      report.skipped.push({
        id: p.id,
        title: p.title,
        productType: p.productType || '',
        collections: p.collections || [],
        tags: p.tags || [],
      });
    }
  }

  return report;
}

function printTerms(map) {
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1]);
  if (!rows.length) return '  (none)';
  return rows.map(([term, count]) => `  ${term} (${count})`).join('\n');
}

async function main() {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  if (!shop) {
    console.error('SHOPIFY_SHOP_DOMAIN is not set in .env');
    process.exitCode = 1;
    return;
  }

  const token = await getAdminAccessToken();
  const categories = getCategoryList();

  console.log(`Fetching products from ${shop} (may take a moment)...`);
  const products = await fetchAllProducts(shop, token);
  const report = buildReport(products, categories);

  console.log('\n=== SDS CATALOG AUDIT ===');
  console.log(`Catalog size:                 ${report.total}`);
  console.log(`Products with an SDS URL:     ${report.withSds}`);
  console.log(`  - would be emailed today:   ${report.matchCount}`);
  console.log(`  - would be SKIPPED today:   ${report.skipCount}`);
  console.log(`  (products without an SDS metafield are not counted)`);

  console.log('\n--- Distinct terms among SKIPPED products ---');
  console.log('Product types:');
  console.log(printTerms(report.unmatchedTerms.types));
  console.log('Collections:');
  console.log(printTerms(report.unmatchedTerms.collections));
  console.log('Tags:');
  console.log(printTerms(report.unmatchedTerms.tags));

  console.log('\n--- Distinct terms among MATCHED products (already covered) ---');
  console.log('Product types:');
  console.log(printTerms(report.matchedTerms.types));
  console.log('Collections:');
  console.log(printTerms(report.matchedTerms.collections));
  console.log('Tags:');
  console.log(printTerms(report.matchedTerms.tags));

  console.log('\n--- SKIPPED products (would currently receive NO email) ---');
  if (!report.skipped.length) {
    console.log('  (none)');
  } else {
    for (const p of report.skipped) {
      console.log(
        `  - ${p.title}\n` +
          `      type: ${p.productType || '(empty)'}\n` +
          `      collections: [${p.collections.join(' | ')}]\n` +
          `      tags: [${p.tags.join(' | ')}]`
      );
    }
  }

  console.log('\n--- Suggestion ---');
  console.log(
    'Extend SDS_CATEGORIES in .env for any SKIPPED terms that are genuinely chemical, ' +
      'or add a qualifying tag/collection to those products. Current SDS_CATEGORIES:\n  ' +
      (process.env.SDS_CATEGORIES || 'Chemicals,Odour Control,Eco Friendly Chemicals,Hand Sanitiser,Hand Soap,Hand Wipes')
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { buildReport };
