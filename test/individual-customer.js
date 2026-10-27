/**
 * Individual (non-B2B) customer path for the SDS opt-out check.
 *
 * A private customer has NO company and NO custom.sds_email_opt_out metafield at
 * all - which is a different state from the metafield existing with value
 * "false". This harness asserts the ONLY correct outcome: send the email.
 *
 * It also asserts the store-level failure mode: if the store has no B2B feature
 * (or the app lacks read_companies), the purchasingEntity query fails on EVERY
 * order. That must not block sending, and must not be re-attempted per order.
 */
const path = require('node:path');
const assert = require('node:assert');

const shopifyPath = require.resolve('../src/shopify');
let mode = 'individual';
const counts = { company: 0, customer: 0 };

require.cache[shopifyPath] = {
  id: shopifyPath,
  filename: shopifyPath,
  loaded: true,
  exports: {
    ADMIN_API_VERSION: '2026-07',
    shopifyGraphQL: async (shop, token, query) => {
      if (query.includes('SdsOptOutCompany')) {
        counts.company++;
        if (mode === 'schema-error') {
          throw new Error(
            "Shopify GraphQL errors: Field 'purchasingEntity' doesn't exist on type 'Order'"
          );
        }
        // Individual order: no purchasing company at all.
        return { order: { id: 'gid://shopify/Order/7239405830283', name: 'CCSWS-1848', purchasingEntity: null } };
      }
      if (query.includes('SdsOptOutCustomer')) {
        counts.customer++;
        // Individual customer: no opt-out metafield exists.
        return {
          customer: {
            id: 'gid://shopify/Customer/7000000000001',
            displayName: 'Michelle Dannatt',
            email: 'xrlent@hotmail.com',
            metafields: { nodes: [] },
          },
        };
      }
      throw new Error('unexpected query');
    },
  },
};

const exclusions = require('../src/exclusions');
const { checkExclusions, clearExclusionCache } = exclusions;
const resetCompanyLookupSupport = exclusions.resetCompanyLookupSupport;

const SHOP = '49uc1c-ac.myshopify.com';
const ORDER = { id: 7239405830283, email: 'xrlent@hotmail.com', customer: { id: 7000000000001, first_name: 'Michelle' } };

const out = [];
function ok(label, cond, detail) {
  assert.ok(cond, `${label} :: ${detail}`);
  out.push(`PASS  ${label.padEnd(62)} ${detail}`);
}

(async () => {
  // ---- case 1: individual order, no company, no metafield ----
  mode = 'individual';
  counts.company = 0; counts.customer = 0;
  if (resetCompanyLookupSupport) resetCompanyLookupSupport();
  clearExclusionCache();
  const r1 = await checkExclusions(SHOP, 'stub', ORDER);
  ok('individual order (no company, no metafield)', r1.excluded === false, `excluded=${r1.excluded}`);
  ok('individual order: companyReason says no company', /no company|unsupported/i.test(String(r1.companyReason)), `companyReason="${r1.companyReason}"`);
  ok('individual order: customerReason says no metafield', /no opt-out metafield set/.test(String(r1.reason)), `reason="${r1.reason}"`);

  // ---- case 2: order with no customer object at all (guest checkout) ----
  mode = 'individual';
  clearExclusionCache();
  const r2 = await checkExclusions(SHOP, 'stub', { id: 7239405830283, email: 'xrlent@hotmail.com' });
  ok('guest order (no customer object)', r2.excluded === false, `excluded=${r2.excluded}`);

  // ---- case 3: store without B2B -> purchasingEntity query errors ----
  mode = 'schema-error';
  counts.company = 0; counts.customer = 0;
  if (resetCompanyLookupSupport) resetCompanyLookupSupport();
  clearExclusionCache();
  const r3 = await checkExclusions(SHOP, 'stub', ORDER);
  ok('store without B2B (query throws)', r3.excluded === false, `excluded=${r3.excluded}`);

  // ---- case 4: the failing company query must NOT be retried per order ----
  const before = counts.company;
  clearExclusionCache();
  await checkExclusions(SHOP, 'stub', { id: 7239405830999, email: 'someone@else.com', customer: { id: 7000000000002 } });
  const after = counts.company;
  ok(
    'unsupported company lookup is not retried',
    after === before,
    `company queries during 2nd order: ${after - before} (before fix: 1)`
  );

  console.log(out.join('\n'));
  console.log(`\nALL ${out.length} INDIVIDUAL-CUSTOMER CHECKS PASSED`);
})().catch((e) => {
  console.error('INDIVIDUAL-CUSTOMER CHECK FAILED:', e.message);
  process.exitCode = 1;
});
