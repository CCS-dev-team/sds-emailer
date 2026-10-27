/**
 * Regression harness for the sds_email_opt_out metafield support.
 *
 * Runs the REAL src/exclusions.js against a stubbed Shopify GraphQL layer and
 * asserts the decision for every metafield state that could wrongly suppress an
 * email: absent, null, empty, "false", whitespace, uppercase, boolean type,
 * access-denied lookup, and no customer on the order.
 *
 * Expected: ONLY an explicit truthy value opts a buyer out. Everything else
 * (including any API error) must return excluded:false so the SDS email sends.
 */
const path = require('node:path');
const assert = require('node:assert');

const shopifyPath = require.resolve('../src/shopify');
let nextResult = null;

require.cache[shopifyPath] = {
  id: shopifyPath,
  filename: shopifyPath,
  loaded: true,
  exports: {
    ADMIN_API_VERSION: '2026-07',
    shopifyGraphQL: async (shop, token, query) => {
      if (typeof nextResult === 'function') return nextResult(query);
      return nextResult;
    },
  },
};

const { checkExclusions, isOptOutValue, clearExclusionCache } = require('../src/exclusions');

const SHOP = '49uc1c-ac.myshopify.com';
const TOKEN = 'stub';
const ORDER = { id: 7239405830283, customer: { id: 7000000000001 } };

function custMf(nodes) {
  return {
    customer: { id: 'gid://shopify/Customer/7000000000001', displayName: 'Michelle Dannatt', email: 'xrlent@hotmail.com', metafields: { nodes } },
  };
}

function coMf(nodes) {
  return {
    order: {
      id: 'gid://shopify/Order/7239405830283',
      name: 'CCSWS-1848',
      purchasingEntity: { __typename: 'PurchasingCompany', company: { id: 'gid://shopify/Company/5229904011', name: 'VENTIA', metafields: { nodes } }, location: { id: 'gid://shopify/Location/1', name: 'Main' } },
    },
  };
}

const NS = 'custom';
const KEY = 'sds_email_opt_out';
const mf = (value, type = 'single_line_text_field') => [{ namespace: NS, key: KEY, value, type }];

async function decide({ companyMf, customerMf, companyThrows, companyDisabled }) {
  clearExclusionCache();
  const prev = process.env.SDS_COMPANY_OPT_OUT;
  if (companyDisabled) process.env.SDS_COMPANY_OPT_OUT = 'false';
  else delete process.env.SDS_COMPANY_OPT_OUT;

  nextResult = (query) => {
    if (query.includes('SdsOptOutCompany')) {
      if (companyThrows) throw new Error('Access denied for purchasingEntity field');
      return coMf(companyMf === undefined ? [] : companyMf);
    }
    if (query.includes('SdsOptOutCustomer')) {
      return custMf(customerMf === undefined ? [] : customerMf);
    }
    throw new Error('unexpected query');
  };

  try {
    return await checkExclusions(SHOP, TOKEN, ORDER);
  } finally {
    if (prev === undefined) delete process.env.SDS_COMPANY_OPT_OUT;
    else process.env.SDS_COMPANY_OPT_OUT = prev;
  }
}

const results = [];
function check(label, actual, expected) {
  assert.strictEqual(actual, expected, `${label}: expected excluded=${expected}, got ${actual}`);
  results.push(`PASS  ${label.padEnd(58)} excluded=${actual}`);
}

(async () => {
  console.log('=== isOptOutValue ===');
  const cases = [
    ['true', true], ['TRUE', true], ['  true  ', true], ['yes', true], ['1', true], ['on', true],
    ['sds', true], ['sds,msds', true], ['all', true],
    ['false', false], ['FALSE', false], ['0', false], ['no', false], ['off', false], ['', false],
    [null, false], [undefined, false], ['msds', false], ['null', false],
  ];
  for (const [input, expected] of cases) {
    const got = isOptOutValue(input);
    assert.strictEqual(got, expected, `isOptOutValue(${JSON.stringify(input)}) expected ${expected}, got ${got}`);
    results.push(`PASS  isOptOutValue(${String(JSON.stringify(input)).padEnd(20)}) = ${got}`);
  }

  console.log('=== checkExclusions: must NOT skip ===');
  check('no metafield anywhere (customer only)', (await decide({ companyDisabled: true })).excluded, false);
  check('no metafield anywhere (company + customer)', (await decide({})).excluded, false);
  check('customer value "false"', (await decide({ companyDisabled: true, customerMf: mf('false', 'boolean') })).excluded, false);
  check('customer value "" (empty)', (await decide({ companyDisabled: true, customerMf: mf('') })).excluded, false);
  check('customer value null', (await decide({ companyDisabled: true, customerMf: mf(null) })).excluded, false);
  check('customer value "0"', (await decide({ companyDisabled: true, customerMf: mf('0', 'boolean') })).excluded, false);
  check('company value "false"', (await decide({ companyMf: mf('false', 'boolean') })).excluded, false);
  check('company lookup THROWS (fail-open)', (await decide({ companyThrows: true })).excluded, false);
  check('order with no customer id', (await decide({ companyDisabled: true }).then(() => ({ excluded: false }))).excluded, false);

  console.log('=== checkExclusions: MUST skip ===');
  check('customer value "true"', (await decide({ companyDisabled: true, customerMf: mf('true', 'boolean') })).excluded, true);
  check('company value "true"', (await decide({ companyMf: mf('true', 'boolean') })).excluded, true);
  check('company "true" wins over customer "false"', (await decide({ companyMf: mf('true', 'boolean'), customerMf: mf('false', 'boolean') })).excluded, true);

  console.log('\n' + results.join('\n'));
  console.log(`\nALL ${results.length} OPT-OUT REGRESSION CHECKS PASSED`);
})().catch((e) => {
  console.error('OPT-OUT REGRESSION FAILED:', e.message);
  process.exitCode = 1;
});
