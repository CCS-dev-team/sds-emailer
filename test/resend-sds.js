/**
 * Resend the SDS email for ONE order - or show exactly what WOULD be sent.
 *
 * Read-only by default. It runs the same pipeline the live webhook runs
 * (Admin API product lookup -> category + custom.download_pdf_file match ->
 * metafield opt-out check -> SendGrid), prints every gate with its real answer,
 * and stops before sending. Add --send to deliver.
 *
 * It never writes data/processed-orders.json, so if the webhook for the same
 * order fires later the customer can still receive a second copy. Only use
 * --send for an order that genuinely never got its email.
 *
 * Scopes are read from Shopify at run time (currentAppInstallation.accessScopes)
 * and printed, so nothing in the output is an assumption:
 *   - read_orders, read_products  -> order lookup + product/metafield lookup
 *   - read_customers              -> customer opt-out metafield is evaluated
 *   - read_companies              -> B2B company opt-out metafield is evaluated
 * src/exclusions.js gates both opt-out checks on read_customers; a missing
 * read_companies makes the company query fail open (logged, email still sends).
 *
 * Accepts an order name, a numeric order id, a gid, or a customer email.
 *
 * Usage (PowerShell, from the folder that contains package.json):
 *   node test\resend-sds.js CCSWS-1848
 *   node test\resend-sds.js CCSWS-1848 --send
 *   node test\resend-sds.js 7254409216139 --send
 *   node test\resend-sds.js xrlent@hotmail.com
 *   node test\resend-sds.js CCSWS-1848 --send --to other@example.com
 *
 * Flags:
 *   --send            actually deliver via SendGrid (default is a dry run)
 *   --dry-run         explicit dry run; same as the default, safe to pass
 *   --to <address>    override the recipient (default: order.email)
 *   --help            print usage
 */
const fs = require('node:fs');
const path = require('node:path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { shopifyGraphQL } = require('../src/shopify');
const { findSdsItems } = require('../src/sds');
const { checkExclusions } = require('../src/exclusions');
const { getAdminAccessToken } = require('../src/auth');
const { initSendGrid, sendSdsEmail } = require('../src/email');

const USAGE =
  'Usage: node test\\resend-sds.js <order-name|order-id|gid|email> [--send] [--dry-run] [--to address]';

const REQUIRED_SCOPES = ['read_orders', 'read_products', 'read_customers', 'read_companies'];

const ORDER_FIELDS = `
      id
      name
      email
      createdAt
      cancelledAt
      displayFinancialStatus
      displayFulfillmentStatus
      billingAddress { firstName lastName company }
      shippingAddress { firstName lastName company }
      lineItems(first: 100) {
        nodes { title sku quantity product { id title } }
      }`;

const ORDER_QUERY_WITH_CUSTOMER = `query ResendOrder($q: String!) {
  orders(first: 10, query: $q) {
    nodes {
      customer { id firstName lastName displayName email }
${ORDER_FIELDS}
    }
  }
}`;

const ORDER_QUERY_NO_CUSTOMER = `query ResendOrder($q: String!) {
  orders(first: 10, query: $q) {
    nodes {
${ORDER_FIELDS}
    }
  }
}`;

const SCOPES_QUERY = `query ResendScopes {
  currentAppInstallation { accessScopes { handle } }
}`;

function parseArgs(argv) {
  const out = { ref: null, send: false, to: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--send') out.send = true;
    else if (a === '--dry-run' || a === '--dryrun' || a === '--no-send') out.send = false;
    else if (a === '--to') {
      out.to = argv[i + 1] || null;
      i += 1;
    } else if (a.startsWith('--to=')) out.to = a.slice('--to='.length);
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('--') && !out.ref) out.ref = a;
  }
  return out;
}

function buildSearch(ref) {
  const raw = String(ref || '').trim();
  if (!raw) return null;
  if (raw.startsWith('gid://')) return `id:${raw.replace(/\D/g, '')}`;
  if (/^\d+$/.test(raw)) return `id:${raw}`;
  if (raw.includes('@')) return `email:${raw}`;
  return `name:'${raw.replace(/^#/, '')}'`;
}

function greetingName(order) {
  const customer = order.customer || {};
  const ship = order.shippingAddress || {};
  const bill = order.billingAddress || {};
  return customer.firstName || ship.firstName || bill.firstName || '';
}

function addressCompany(order) {
  const ship = order.shippingAddress || {};
  const bill = order.billingAddress || {};
  return ship.company || bill.company || '';
}

function customerLabel(order) {
  const c = order.customer;
  if (!c) return '(not readable with this token)';
  const name = `${c.firstName || ''} ${c.lastName || ''}`.trim();
  return name || c.displayName || c.id;
}

async function fetchGrantedScopes(shop, token) {
  try {
    const data = await shopifyGraphQL(shop, token, SCOPES_QUERY);
    const nodes =
      (data && data.currentAppInstallation && data.currentAppInstallation.accessScopes) || [];
    return nodes.map((n) => (n && n.handle) || '').filter(Boolean);
  } catch (err) {
    return null;
  }
}

async function fetchOrder(shop, token, q) {
  try {
    const data = await shopifyGraphQL(shop, token, ORDER_QUERY_WITH_CUSTOMER, { q });
    return { data, customerReadable: true };
  } catch (err) {
    if (!/read_customers|Access denied|customer field/i.test(String(err.message))) throw err;
    console.warn(
      '[resend] order.customer rejected by Shopify; retrying without it. ' +
        'The customer-level opt-out cannot be evaluated in this run.'
    );
    const data = await shopifyGraphQL(shop, token, ORDER_QUERY_NO_CUSTOMER, { q });
    return { data, customerReadable: false };
  }
}

function deepContains(node, needle, depth = 0) {
  if (node === null || node === undefined || depth > 6) return false;
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node).includes(needle);
  }
  if (Array.isArray(node)) return node.some((v) => deepContains(v, needle, depth + 1));
  if (typeof node === 'object') {
    return Object.keys(node).some(
      (k) => k.includes(needle) || deepContains(node[k], needle, depth + 1)
    );
  }
  return false;
}

/** Read-only look at the webhook's own duplicate-suppression ledger. */
function readLedgerStatus(orderGid) {
  const configured = process.env.PROCESSED_ORDERS_FILE || './data/processed-orders.json';
  const abs = path.isAbsolute(configured) ? configured : path.resolve(__dirname, '..', configured);
  const needle = String(orderGid).replace(/\D/g, '');

  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'no-file', file: abs };
    return { state: 'unreadable', file: abs, error: err.message };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { state: 'unreadable', file: abs, error: 'invalid JSON' };
  }

  return { state: deepContains(parsed, needle) ? 'present' : 'absent', file: abs };
}

function describeLedger(ledger, orderGid) {
  const id = String(orderGid).replace(/\D/g, '');
  if (ledger.state === 'present') {
    return `already recorded for order ${id} - the live webhook would treat this order as emailed`;
  }
  if (ledger.state === 'absent') {
    return `order ${id} not recorded - the live webhook would still email it once`;
  }
  if (ledger.state === 'no-file') return `no ledger file yet (${ledger.file})`;
  return `ledger unreadable (${ledger.file}: ${ledger.error})`;
}

function reportScopes(scopes) {
  if (!scopes) {
    console.log('Scopes:       (could not read granted scopes - token or domain problem)');
    console.log('              opt-out results below are therefore informational only');
    return { canReadCustomers: null };
  }
  console.log(`Scopes:       ${scopes.join(', ') || '(none granted)'}`);
  for (const scope of REQUIRED_SCOPES) {
    const granted = scopes.includes(scope);
    let note = '';
    if (scope === 'read_customers' && !granted) {
      note = ' -> opt-out checks NOT evaluated (src\\exclusions.js gates on this scope)';
    }
    if (scope === 'read_companies' && !granted) {
      note = ' -> company query will fail open (email still sends)';
    }
    console.log(`  ${scope.padEnd(15)} ${granted ? 'granted' : 'MISSING'}${note}`);
  }
  return { canReadCustomers: scopes.includes('read_customers') };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.ref) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  if (!shop) throw new Error('SHOPIFY_SHOP_DOMAIN is missing from .env');

  const token = await getAdminAccessToken();
  const q = buildSearch(args.ref);

  const { data, customerReadable } = await fetchOrder(shop, token, q);
  const nodes = (data && data.orders && data.orders.nodes) || [];

  if (nodes.length === 0) {
    throw new Error(`No order found in ${shop} for "${args.ref}" (query: ${q})`);
  }
  if (nodes.length > 1) {
    console.log(`[resend] ${nodes.length} orders matched "${args.ref}" (query: ${q}):`);
    for (const n of nodes) {
      console.log(`  - ${n.name} (${n.id}) ${n.email || '(no email)'} ${n.createdAt || ''}`);
    }
    console.log('[resend] narrow the reference to a single order and re-run');
    return;
  }

  const order = nodes[0];
  const scopes = await fetchGrantedScopes(shop, token);
  const lineItems = ((order.lineItems && order.lineItems.nodes) || []).map((li) => ({
    title: li.title,
    sku: li.sku,
    quantity: li.quantity,
    productId: (li.product && li.product.id) || null,
  }));

  console.log('\n================ RESEND SDS ================');
  console.log(`Order:        ${order.name} (${order.id})`);
  console.log(`Created:      ${order.createdAt || '?'}`);
  console.log(`Fulfillment:  ${order.displayFulfillmentStatus || '?'}`);
  console.log(`Financial:    ${order.displayFinancialStatus || '?'}`);
  if (order.cancelledAt) console.log(`CANCELLED:    ${order.cancelledAt}`);
  console.log(`order.email:  ${order.email || '*** EMPTY ***'}`);
  console.log(`customer:     ${customerLabel(order)}`);
  console.log(`greeting:     ${greetingName(order) || '(falls back to "there")'}`);
  console.log(`address co:   ${addressCompany(order) || '(none)'}`);
  const scopeFacts = reportScopes(scopes);
  console.log(`Line items:   ${lineItems.length}`);

  const items = await findSdsItems(shop, token, { lineItems });

  const exclusion = await checkExclusions(shop, token, {
    id: order.id,
    customer: order.customer && order.customer.id ? { id: order.customer.id } : null,
  });

  const ledger = readLedgerStatus(order.id);

  console.log('');
  console.log(
    `Opt-out:      ${
      exclusion.excluded
        ? `${exclusion.scope} "${exclusion.name}" via ${exclusion.metafield}`
        : 'none'
    }`
  );
  console.log(`company chk:  ${exclusion.companyReason || '(no reason reported)'}`);
  console.log(
    `customer chk: ${exclusion.customerReason || exclusion.reason || '(no reason reported)'}`
  );
  console.log(`SDS rows:     ${items.length}`);
  for (const item of items) {
    console.log(`  - ${item.productName} [${item.sku}] ${item.sdsUrl}`);
  }
  console.log(`webhook ledger: ${describeLedger(ledger, order.id)}`);

  const to = args.to || order.email;

  if (exclusion.excluded) {
    console.log(
      `\nVERDICT: NOT SENDING - opted out at ${exclusion.scope} level. ` +
        `Clear ${exclusion.metafield} to allow SDS emails.`
    );
    return;
  }
  if (items.length === 0) {
    console.log(
      '\nVERDICT: NOT SENDING - no qualifying SDS products. ' +
        'Check the [sds] lines above: a product needs a category match AND a populated ' +
        'custom.download_pdf_file metafield.'
    );
    return;
  }
  if (!to) {
    console.log('\nVERDICT: NOT SENDING - the order has no email address. Re-run with --to <address>.');
    return;
  }
  if (customerReadable === false) {
    console.log(
      '\nNOTE: the customer-level opt-out was NOT evaluated in this run ' +
        '(order.customer unreadable with this token).'
    );
  }
  if (scopeFacts.canReadCustomers === false) {
    console.log(
      'NOTE: read_customers is missing from the token, so src\\exclusions.js skipped both ' +
        'opt-out checks. Grant it and re-authorise before relying on opt-outs.'
    );
  }
  if (args.to && order.email && args.to !== order.email) {
    console.log(`NOTE: --to overrides the customer address (${order.email}).`);
  }

  if (!args.send) {
    console.log(`\nVERDICT: WOULD SEND ${items.length} item(s) to ${to}`);
    console.log('Dry run only - nothing was sent and no ledger entry was written.');
    console.log('Re-run with --send to actually deliver.');
    return;
  }

  initSendGrid();
  if (!process.env.SENDGRID_FROM) throw new Error('SENDGRID_FROM is not set in .env');

  const res = await sendSdsEmail({ to, firstName: greetingName(order), items });
  const statuses = (Array.isArray(res) ? res : [res])
    .map((r) => (r && r.statusCode ? r.statusCode : 'sent'))
    .join(',');
  console.log(`\nSENT ${items.length} item(s) to ${to} via SendGrid (HTTP ${statuses}).`);
  console.log('Delivery is not confirmed here - check SendGrid Activity and Suppressions.');
}

main().catch((err) => {
  console.error('RESEND FAILED:', err.message);
  process.exitCode = 1;
});
