/**
 * Read-only diagnosis for ONE order. Answers, in a single run:
 *   1. is the Admin API token working?
 *   2. are the ORDERS_PAID / ORDERS_FULFILLED webhook subscriptions still alive?
 *   3. what does the app actually see for this order (status, email, line items)?
 *   4. does the product match a category, and does it have an SDS URL?
 *   5. is the buyer opted out?
 *   6. what would the webhook do right now - SEND or SKIP, and at which gate?
 *
 * Nothing is sent, nothing is written, no webhook is replayed.
 *
 * Usage:
 *   node test\diagnose-order.js CCSWS-1848
 *   node test\diagnose-order.js 6723234889867
 *   node test\diagnose-order.js gid://shopify/Order/6723234889867
 */
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { shopifyGraphQL } = require('../src/shopify');
const { findSdsItems, getCategoryList, DEFAULT_CATEGORIES } = require('../src/sds');
const { checkExclusions } = require('../src/exclusions');
const { getAdminAccessToken } = require('../src/auth');

const SHOP_QUERY = `query DiagShop { shop { name myshopifyDomain currencyCode } }`;

const HOOKS_QUERY = `query DiagHooks {
  webhookSubscriptions(first: 25) {
    nodes {
      id
      topic
      createdAt
      updatedAt
      endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } }
    }
  }
}`;

const ORDER_FULL = `query DiagOrder($q: String!) {
  orders(first: 5, query: $q) {
    nodes {
      id
      name
      email
      createdAt
      processedAt
      cancelledAt
      displayFinancialStatus
      displayFulfillmentStatus
      customer { id firstName lastName email }
      purchasingEntity {
        __typename
        ... on PurchasingCompany { company { id name } location { id name } }
      }
      lineItems(first: 50) { nodes { title sku quantity product { id title } } }
    }
  }
}`;

const ORDER_MIN = `query DiagOrderMin($q: String!) {
  orders(first: 5, query: $q) {
    nodes {
      id name email createdAt
      customer { id firstName email }
      lineItems(first: 50) { nodes { title sku quantity product { id title } } }
    }
  }
}`;

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

function nearMisses(product, categories) {
  const haystacks = [
    product.productType,
    ...(product.collections || []),
    ...(product.tags || []),
  ].filter(Boolean);

  const out = [];
  for (const h of haystacks) {
    const hn = norm(h);
    for (const c of categories) {
      if (!c || hn === c) continue;
      if (hn.includes(c) || c.includes(hn)) {
        out.push(`"${h}" vs category "${c}"`);
      }
    }
  }
  return out;
}

async function resolveOrder(shop, accessToken, arg) {
  const raw = String(arg || '').trim();
  const isGid = raw.startsWith('gid://');
  const isNumeric = /^\d+$/.test(raw);
  const q = isGid ? `id:${raw.replace(/\D/g, '')}` : `name:'${raw}'`;

  let data;
  try {
    data = await shopifyGraphQL(shop, accessToken, ORDER_FULL, { q });
  } catch (err) {
    console.warn(`[diagnose] full order query failed (${err.message}); retrying minimal fields`);
    data = await shopifyGraphQL(shop, accessToken, ORDER_MIN, { q });
  }

  const nodes = (data && data.orders && data.orders.nodes) || [];
  if (!nodes.length) throw new Error(`No order found for "${raw}"`);

  if (isNumeric || isGid) {
    const digits = raw.replace(/\D/g, '');
    return nodes.find((n) => String(n.id).endsWith(digits)) || nodes[0];
  }
  return nodes.find((n) => norm(n.name) === norm(raw)) || nodes[0];
}

async function runDiagnostics(orderRef) {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  if (!shop) throw new Error('SHOPIFY_SHOP_DOMAIN is missing from .env');

  const token = await getAdminAccessToken();
  const line = (t) => console.log(t);

  line('\n================ SDS EMAILER DIAGNOSIS ================');
  line(`Run at:            ${new Date().toISOString()}`);
  line(`Shop:              ${shop}`);
  line(`API version:       ${process.env.SHOPIFY_API_VERSION || '2026-07'}`);
  line(`Token mode:        ${process.env.SHOPIFY_ADMIN_ACCESS_TOKEN ? 'explicit SHOPIFY_ADMIN_ACCESS_TOKEN' : 'client-credentials grant'}`);
  line(`Token prefix:      ${String(token).slice(0, 5)}... (len ${String(token).length})`);
  line(`Webhook secret set: ${Boolean(process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_CLIENT_SECRET)} (from ${process.env.SHOPIFY_API_SECRET ? 'SHOPIFY_API_SECRET' : process.env.SHOPIFY_CLIENT_SECRET ? 'SHOPIFY_CLIENT_SECRET' : 'NOTHING'})`);
  line(`Expected endpoint: ${process.env.WEBHOOK_CALLBACK_URL || '(WEBHOOK_CALLBACK_URL not set)'}`);

  // ---- 1. token ----
  try {
    const d = await shopifyGraphQL(shop, token, SHOP_QUERY);
    line(`\n[1] TOKEN:           OK - shop "${d.shop.name}" (${d.shop.myshopifyDomain})`);
  } catch (err) {
    line(`\n[1] TOKEN:           *** FAILED *** ${err.message}`);
    line('    => everything downstream is unreliable. Re-authorise the app and update');
    line('       SHOPIFY_ADMIN_ACCESS_TOKEN locally AND in Render, then redeploy.');
  }

  // ---- 2. webhook subscriptions ----
  let hookOk = false;
  try {
    const d = await shopifyGraphQL(shop, token, HOOKS_QUERY);
    const hooks = (d.webhookSubscriptions && d.webhookSubscriptions.nodes) || [];
    line(`\n[2] WEBHOOKS:        ${hooks.length} subscription(s) on the store`);
    for (const h of hooks) {
      const url = (h.endpoint && h.endpoint.callbackUrl) || '(non-http endpoint)';
      line(`    - ${String(h.topic).padEnd(22)} ${url}`);
      line(`      id ${h.id} | updated ${h.updatedAt || h.createdAt || '?'}`);
    }
    for (const topic of ['ORDERS_PAID', 'ORDERS_FULFILLED']) {
      const found = hooks.find((h) => String(h.topic).toUpperCase() === topic);
      if (found) {
        hookOk = true;
        line(`    ${topic}: PRESENT`);
      } else {
        line(`    ${topic}: *** MISSING *** - Shopify is not delivering this event.`);
      }
    }
    if (!hookOk) line('    => re-run: npm run register-webhook');
  } catch (err) {
    line(`\n[2] WEBHOOKS:        *** could not list *** ${err.message}`);
    line('    => the app may lack read_webhooks/scope, or the token is bad.');
  }

  // ---- 3. order ----
  const order = await resolveOrder(shop, token, orderRef);
  line(`\n[3] ORDER:           ${order.name || '?'}  (${order.id})`);
  line(`    recipient:        ${order.email || '*** NULL/EMPTY ***'}   [order.email]`);
  if (order.createdAt) line(`    created:          ${order.createdAt}`);
  if (order.processedAt) line(`    paid/processed:   ${order.processedAt}`);
  if (order.displayFinancialStatus) line(`    financial:        ${order.displayFinancialStatus}`);
  if (order.displayFulfillmentStatus) line(`    fulfillment:      ${order.displayFulfillmentStatus}`);
  if (order.cancelledAt) line(`    *** CANCELLED *** ${order.cancelledAt}`);
  if (order.purchasingEntity) {
    const co = order.purchasingEntity.company;
    line(`    purchasingEntity: ${order.purchasingEntity.__typename}${co ? ` - ${co.name} (${co.id})` : ''}`);
  } else {
    line('    purchasingEntity: (none - not a B2B company order)');
  }
  const customer = order.customer;
  line(`    customer:         ${customer ? `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || customer.id : '(no customer on order)'}`);

  // ---- 4. dedupe file ----
  try {
    const fs = require('node:fs');
    const file = process.env.PROCESSED_ORDERS_FILE || path.join(__dirname, '..', 'data', 'processed-orders.json');
    const parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    const sent = Array.isArray(parsed.sentOrderIds) ? parsed.sentOrderIds : [];
    const digits = String(order.id).replace(/\D/g, '');
    const already = sent.some((id) => String(id).replace(/\D/g, '') === digits);
    line(`\n[4] DEDUPE FILE:     ${path.resolve(file)}`);
    line(`    orders marked sent: ${sent.length}${already ? ' -> THIS ORDER IS MARKED AS ALREADY EMAILED' : ' -> this order is NOT marked sent'}`);
  } catch (err) {
    line(`\n[4] DEDUPE FILE:     not readable here (${err.message}) - normal on a fresh machine`);
  }

  // ---- 5. line items -> SDS matching (this prints its own verbose [sds] lines) ----
  const lineItems = (order.lineItems && order.lineItems.nodes ? order.lineItems.nodes : []).map((li) => ({
    title: li.title,
    sku: li.sku,
    productId: li.product && li.product.id ? li.product.id : null,
  }));

  line(`\n[5] LINE ITEMS:      ${lineItems.length}`);
  for (const li of lineItems) {
    line(`    - ${li.title} [${li.sku || 'no sku'}] productId=${li.productId || '*** NULL - product lookup impossible ***'}`);
  }

  const categories = getCategoryList();
  line(`\n    categories in use (${categories.length})${process.env.SDS_CATEGORIES ? ' from SDS_CATEGORIES env' : ' from DEFAULT_CATEGORIES (no env override)'}:`);
  line(`    ${categories.join(' | ')}`);

  const items = await findSdsItems(shop, token, { lineItems });

  // ---- 6. exclusions ----
  const exclusion = await checkExclusions(shop, token, {
    id: order.id,
    customer: customer && customer.id ? { id: customer.id } : null,
  });

  // ---- 7. verdict, mirroring src/server.js ----
  const gates = [];
  if (order.cancelledAt) gates.push('order is CANCELLED');
  if (exclusion.excluded) gates.push(`${exclusion.scope} "${exclusion.name}" opted out (${exclusion.metafield})`);
  if (!lineItems.length) gates.push('order has no line items');
  if (!lineItems.some((li) => li.productId)) gates.push('line items have no product_id (custom/manual item) - no product lookup possible');
  if (!items.length) gates.push('no qualifying SDS products (category match and/or SDS metafield)');
  if (!order.email) gates.push('order.email is empty');

  line('\n================ VERDICT ================');
  if (!items.length) {
    line('This order would NOT be emailed. Blocking gate(s):');
    for (const g of gates) line(`  - ${g}`);
    line('\nReminder: with the CURRENT code a product must match a category EXACTLY');
    line('(case-insensitive, whole string) against product type, a collection title,');
    line('or a tag - see src/sds.js matchesCategory().');
    const p = lineItems.length ? null : null;
    void p;
    if (gates.some((g) => g.startsWith('no qualifying'))) {
      line('\nIf the [sds] lines above show categoryMatch=false, the exact match is why.');
      line('Fix: add the exact tag/collection title to SDS_CATEGORIES (Render env).');
    }
  } else if (gates.length) {
    line(`This order WOULD qualify for ${items.length} SDS row(s) but would be skipped:`);
    for (const g of gates) line(`  - ${g}`);
    for (const i of items) line(`    qualifying: ${i.productName} [${i.sku}] ${i.sdsUrl}`);
  } else {
    line(`WOULD SEND ${items.length} item(s) to ${order.email}`);
    for (const i of items) line(`  - ${i.productName} [${i.sku}] ${i.sdsUrl}`);
  }
  line('Nothing was sent. Nothing was written. No webhook was replayed.');

  return { order, items, exclusion, gates, categories };
}

module.exports = { runDiagnostics };

if (require.main === module) {
  const ref = process.argv[2];
  if (!ref) {
    console.error('Usage: node test\\diagnose-order.js CCSWS-1848');
    process.exitCode = 1;
  } else {
    runDiagnostics(ref).catch((e) => {
      console.error('DIAGNOSIS FAILED:', e.message);
      process.exitCode = 1;
    });
  }
}
