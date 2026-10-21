// Read-only diagnostic. Never loads the server or mailer.
const assert = require('node:assert/strict');

async function main() {
  const path = require('node:path');
const envPath = path.resolve(__dirname, '..', '.env');
const shellTokenPresent =
  process.env.SHOPIFY_ADMIN_ACCESS_TOKEN !== undefined;

const envResult = require('dotenv').config({ path: envPath });

console.log(`Env file: ${envPath}`);
console.log(`Env file loaded: ${envResult.error ? 'NO' : 'YES'}`);
console.log(`Shell token already set: ${shellTokenPresent}`);


  const companyArgument = process.argv[2];
  const mock = !companyArgument;
  const helper = require('../src/shopify');
  const realGraphQL = helper.shopifyGraphQL;
  const exclusionsPath = require.resolve('../src/exclusions');
  const savedCompanySetting = process.env.SDS_COMPANY_OPT_OUT;

  // Test the company branch even if disabled in local settings.
  // This does not change .env or Render.
  process.env.SDS_COMPANY_OPT_OUT = 'true';
  delete require.cache[exclusionsPath];

  try {
    const { getOptOutKey } = require('../src/exclusions');
    const { namespace, key } = getOptOutKey();

    let company;
    let shop = 'test.myshopify.com';
    let token = 'mock-token';

    if (mock) {
      company = {
        id: 'gid://shopify/Company/100',
        name: 'Simulated excluded company',
        metafields: {
          nodes: [{
            namespace,
            key,
            type: 'boolean',
            value: 'true',
          }],
        },
      };
    } else {
      const id = /^\d+$/.test(companyArgument)
        ? `gid://shopify/Company/${companyArgument}`
        : companyArgument;

      if (!/^gid:\/\/shopify\/Company\/\d+$/.test(id)) {
        throw new Error(
          'Use a numeric Company ID or gid://shopify/Company/123'
        );
      }

      shop = process.env.SHOPIFY_SHOP_DOMAIN;

      if (!shop) {
        throw new Error('SHOPIFY_SHOP_DOMAIN is missing from .env');
      }

      console.log(`Shop: ${shop}`);
console.log(`API version: ${helper.ADMIN_API_VERSION}`);
console.log(
  `Explicit token configured: ${
    Boolean(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN)
  }`
);

token = await require('../src/auth').getAdminAccessToken();

console.log(`Token prefix: ${String(token).slice(0, 4)}...`);
console.log(`Token length: ${String(token).length}`);
console.log(
  `Token has outer whitespace: ${
    String(token) !== String(token).trim()
  }`
);
console.log(
  `X-Shopify-Access-Token header populated: ${Boolean(token)}`
);


      // Actual Shopify READ: no order, mutation, or email send.
      const data = await realGraphQL(
        shop,
        token,
        `
          query DryRunCompany(
            $id: ID!,
            $namespace: String!,
            $key: String!
          ) {
            company(id: $id) {
              id
              name
              metafield(namespace: $namespace, key: $key) {
                namespace
                key
                type
                value
              }
            }
          }
        `,
        { id, namespace, key }
      );

      if (!data.company) {
        throw new Error('Company not found or inaccessible');
      }

      company = {
        id: data.company.id,
        name: data.company.name,
        metafields: {
          nodes: data.company.metafield
            ? [data.company.metafield]
            : [],
        },
      };
    }

    // Simulate an order belonging to the company above.
    // The exclusion decision still runs in your real checkExclusions code.
    helper.shopifyGraphQL = async (_shop, _token, query) => {
      if (!query.includes('SdsOptOutCompany')) {
        throw new Error('Unexpected lookup in this company-only test');
      }

      return {
        order: {
          purchasingEntity: { company },
        },
      };
    };

    // Reload so exclusions.js uses our simulated order lookup.
    delete require.cache[exclusionsPath];

    const {
      checkExclusions,
      clearExclusionCache,
    } = require('../src/exclusions');

    clearExclusionCache();

    // Synthetic order ID; no order is created in Shopify.
    const result = await checkExclusions(
      shop,
      token,
      { id: 900000001 }
    );

    if (mock) {
      assert.equal(result.excluded, true);
    }

    console.log(
      `Mode: ${
        mock
          ? 'SIMULATED COMPANY'
          : 'LIVE COMPANY READ; SIMULATED ORDER LINK'
      }`
    );
    console.log(`Company: ${company.name} (${company.id})`);
    console.log(`Metafield: ${namespace}.${key}`);
    console.log(
      `Value: ${company.metafields.nodes[0]?.value ?? '(not set)'}`
    );
    console.log(
      `Result: ${
        result.excluded
          ? 'EXCLUDED'
          : 'WOULD SEND (subject to product/recipient checks)'
      }`
    );
    console.log('No order created or changed. No email sent.');

    clearExclusionCache();
  } finally {
    helper.shopifyGraphQL = realGraphQL;
    delete require.cache[exclusionsPath];

    if (savedCompanySetting === undefined) {
      delete process.env.SDS_COMPANY_OPT_OUT;
    } else {
      process.env.SDS_COMPANY_OPT_OUT = savedCompanySetting;
    }
  }
}

main().catch((error) => {
  console.error('DRY-RUN FAILED:', error.message);
  process.exitCode = 1;
});
