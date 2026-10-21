const assert = require('node:assert/strict');

// Test-only settings. No .env, real credentials, or server required.
process.env.SDS_COMPANY_OPT_OUT = 'true';
process.env.SDS_OPT_OUT_METAFIELD = 'custom.sds_email_opt_out';
process.env.SDS_EXCLUSION_CACHE_MS = '300000';

const originalFetch = global.fetch;
let companyValue;
let customerValue;
let companyPresent = true;
let companyCalls = 0;
let customerCalls = 0;

const fields = (value) => ({
  nodes: value === undefined ? [] : [{
    namespace: 'custom',
    key: 'sds_email_opt_out',
    type: 'boolean',
    value,
  }],
});

// Replace Shopify responses locally; no network requests are made.
global.fetch = async (_url, options) => {
  const { query } = JSON.parse(options.body);
  let data;

  if (query.includes('SdsOptOutCompany')) {
    companyCalls++;
    data = {
      order: {
        purchasingEntity: companyPresent ? {
          company: {
            id: 'gid://shopify/Company/100',
            name: 'Test Company',
            metafields: fields(companyValue),
          },
        } : null,
      },
    };
  } else if (query.includes('SdsOptOutCustomer')) {
    customerCalls++;
    data = {
      customer: {
        id: 'gid://shopify/Customer/200',
        displayName: 'Test Buyer',
        metafields: fields(customerValue),
      },
    };
  } else {
    throw new Error('Unexpected query in test');
  }

  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
  };
};

const {
  checkExclusions,
  clearExclusionCache,
} = require('../src/exclusions');

async function check() {
  clearExclusionCache();

  return checkExclusions('test.myshopify.com', 'test-token', {
    id: 300,
    customer: { id: 200 },
  });
}

(async () => {
  // 1. Company opted out.
  companyValue = 'true';
  let result = await check();

  assert.equal(result.excluded, true);
  assert.equal(result.scope, 'company');
  assert.equal(customerCalls, 0);
  console.log('PASS: company opt-out skips the customer lookup');

  // 2. Company allows emails, but customer opted out.
  companyValue = 'false';
  customerValue = 'true';
  result = await check();

  assert.equal(result.excluded, true);
  assert.equal(result.scope, 'customer');
  console.log('PASS: customer opt-out is honoured');

  // 3. Neither company nor customer opted out.
  customerValue = 'false';
  result = await check();

  assert.equal(result.excluded, false);
  console.log('PASS: false flags do not exclude the order');

  // 4. Ordinary customer with no company and no opt-out flag.
  companyPresent = false;
  customerValue = undefined;
  result = await check();

  assert.equal(result.excluded, false);
  console.log('PASS: no company and no customer flag means no exclusion');

  // Confirm the expected lookups actually occurred.
  assert.equal(companyCalls, 4);
  assert.equal(customerCalls, 3);

  console.log('ALL EXCLUSION CHECKS PASSED');
})().catch((error) => {
  console.error('EXCLUSION TEST FAILURE:', error);
  process.exitCode = 1;
}).finally(() => {
  global.fetch = originalFetch;
  clearExclusionCache();
});
