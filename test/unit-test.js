/* Lightweight sanity checks (no external deps, no network) for the SDS email
 * template and the product/category matching logic.
 *
 * Run:    node test\unit-test.js
 * Expect: ALL UNIT CHECKS PASSED
 *
 * Environment-independent: the test sets/restores SDS_CATEGORIES itself, so it
 * gives the same result whether or not that variable is exported in your shell.
 */
const assert = require('assert');

(async () => {
  const { renderSdsEmail, DEFAULT_CATEGORIES } = require('../src/template');
  const {
    resolveSdsUrl,
    matchesCategory,
    findSdsMetafield,
    evaluateProduct,
    getCategoryList,
  } = require('../src/sds');

  // The 12 confirmed categories, in the order the code declares them.
  const EXPECTED_CATEGORIES = [
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

  // ---------------------------------------------------------------- 1. Email
  const email = renderSdsEmail({
    firstName: 'Alice',
    items: [
      { productName: 'Citrus Degreaser 5L', sku: 'CD-5L', sdsUrl: 'https://cdn.example.com/sds/cd5l.pdf' },
      { productName: 'Hand Sanitiser Gel 500ml', sku: 'HSG-500', sdsUrl: 'https://cdn.example.com/sds/hsg.pdf' },
    ],
  });

  assert.strictEqual(email.subject, 'Safety Data Sheets (SDS) for your recent chemical purchase');
  assert.ok(email.text.includes('Hi Alice,'));
  assert.ok(email.text.includes('Thank you for your recent order with Central Cleaning Supplies.'));
  assert.ok(
    email.text.includes(
      'Because your order includes a chemical product, we have forwarded you links to download the relevant Safety Data Sheet (SDS) for your reference.'
    )
  );
  assert.ok(email.text.includes('Safe handling and storage requirements'));
  assert.ok(email.text.includes('First-aid and emergency measures'));
  assert.ok(email.text.includes('Personal protective equipment recommendations'));
  assert.ok(email.text.includes('Spill, disposal, and transport guidance'));
  assert.ok(email.text.includes('Kind regards,\nCentral Cleaning Supplies'));

  // plain-text rows keep the bare URL (text clients cannot render links)
  assert.ok(email.text.includes('Citrus Degreaser 5L CD-5L - https://cdn.example.com/sds/cd5l.pdf'));
  assert.ok(email.text.includes('Hand Sanitiser Gel 500ml HSG-500 - https://cdn.example.com/sds/hsg.pdf'));

  // HTML rows: "Product Name SKU — View SDS"
  assert.ok(
    email.html.includes(
      '<li>Citrus Degreaser 5L CD-5L &mdash; <a title="View SDS" href="https://cdn.example.com/sds/cd5l.pdf" target="_blank">View SDS</a></li>'
    ),
    'SDS row must be the label followed by the View SDS anchor'
  );
  assert.ok(
    !email.html.includes('<a href="https://cdn.example.com/sds/cd5l.pdf">Citrus Degreaser'),
    'the product label must no longer be the link'
  );
  assert.ok(!email.html.includes('ls/click'), 'no SendGrid click-tracking wrapper in html');
  assert.ok(!email.text.includes('ls/click'), 'no SendGrid click-tracking wrapper in text');

  // greeting fallback
  const noName = renderSdsEmail({
    firstName: '',
    items: [{ productName: 'Citrus Degreaser 5L', sku: 'CD-5L', sdsUrl: 'https://cdn.example.com/sds/cd5l.pdf' }],
  });
  assert.ok(noName.text.includes('Hi there,'));
  assert.ok(noName.html.includes('Hi there,'));

  // -------------------------------------------------- 2. Category constants
  assert.deepStrictEqual(
    DEFAULT_CATEGORIES,
    EXPECTED_CATEGORIES,
    'template.js DEFAULT_CATEGORIES must match the 12 confirmed categories'
  );

  // sds.js exposes the same list through getCategoryList() when SDS_CATEGORIES
  // is unset — asserted with the variable explicitly removed, then restored.
  const savedSdsCategories = process.env.SDS_CATEGORIES;
  delete process.env.SDS_CATEGORIES;
  assert.deepStrictEqual(
    getCategoryList(),
    EXPECTED_CATEGORIES.map((c) => c.toLowerCase()),
    'getCategoryList() defaults must match the 12 confirmed categories (lower-cased)'
  );

  // env override still works, and parsing is comma + trim + lower-case
  process.env.SDS_CATEGORIES = 'Chemicals, Spill Kit ,SURFACE DISINFECTANTS & SANITISERS';
  assert.deepStrictEqual(getCategoryList(), [
    'chemicals',
    'spill kit',
    'surface disinfectants & sanitisers',
  ]);

  if (savedSdsCategories === undefined) delete process.env.SDS_CATEGORIES;
  else process.env.SDS_CATEGORIES = savedSdsCategories;

  // ------------------------------------------- 3. Category matching behaviour
  // Clear positives: the exact category names used as tag / collection / type.
  const list = EXPECTED_CATEGORIES.map((c) => c.toLowerCase());
  assert.ok(matchesCategory({ productType: 'Chemicals', collections: [], tags: [] }, list), 'product type match');
  assert.ok(matchesCategory({ productType: '', collections: ['Odour Control'], tags: [] }, list), 'collection match');
  assert.ok(matchesCategory({ productType: '', collections: [], tags: ['Spill Kit'] }, list), 'tag match');
  assert.ok(
    matchesCategory({ productType: '', collections: ['Cleaning Chemicals'], tags: [] }, list),
    'Cleaning Chemicals collection match'
  );
  assert.ok(
    matchesCategory({ productType: '', collections: [], tags: ['HAND SANITISER'] }, list),
    'matching is case-insensitive'
  );
  assert.ok(
    matchesCategory({ productType: '', collections: [], tags: ['insect repellants'] }, list),
    'Insect Repellants tag match'
  );

  // Clear negatives: unrelated terms must never qualify a product.
  for (const bad of ['Brooms', 'Mops', 'Vacuum Cleaners', 'Microfibre Cloths']) {
    assert.ok(
      !matchesCategory({ productType: 'Janitorial', collections: [bad], tags: [bad] }, list),
      `"${bad}" must not match any category`
    );
  }

  // ------------------------------------- 4. Metafield resolution (both types)
  assert.strictEqual(
    resolveSdsUrl({ value: 'https://cdn.example.com/a.pdf', type: 'url' }),
    'https://cdn.example.com/a.pdf'
  );
  assert.strictEqual(
    resolveSdsUrl({
      value: 'gid://shopify/GenericFile/123',
      type: 'file_reference',
      reference: { url: 'https://cdn.shopify.com/s/files/a.pdf' },
    }),
    'https://cdn.shopify.com/s/files/a.pdf'
  );
  assert.strictEqual(resolveSdsUrl(null), null);
  assert.strictEqual(resolveSdsUrl({ value: '', type: 'url' }), null);
  assert.strictEqual(
    resolveSdsUrl({ value: '{"type":"root","children":[]}', type: 'rich_text_field' }),
    null,
    'rich_text_field payloads must never be treated as an SDS URL'
  );

  // preference order: exact custom.download_pdf_file wins over a loose match
  const found = findSdsMetafield([
    { namespace: 'custom', key: 'sds_something', type: 'url', value: 'https://x/sds.pdf' },
    { namespace: 'custom', key: 'download_pdf_file', type: 'url', value: 'https://x/exact.pdf' },
  ]);
  assert.strictEqual(found.value, 'https://x/exact.pdf');

  // ------------------------------- 5. Real catalogue shape (inline TAU5-like)
  const tau5 = {
    id: 'gid://shopify/Product/7976784920715',
    title: 'Agar Taurus Laundry Detergent 5L',
    productType: '',
    tags: ['Cleaning Chemicals', 'Washing Powders Detergents & Rinses'],
    collections: ['Cleaning Chemicals', 'Washing Powders, Detergents & Rinses', 'Agar'],
    metafield: {
      namespace: 'custom',
      key: 'download_pdf_file',
      type: 'url',
      value: 'https://cdn.shopify.com/s/files/1/0680/4606/1707/files/TAU5.pdf?v=1775454511',
    },
    metafields: [
      { namespace: 'custom', key: 'industrie', type: 'rich_text_field', value: '{"type":"root"}' },
      { namespace: 'custom', key: 'material', type: 'rich_text_field', value: '{"type":"root"}' },
      { namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: 'Taurus' },
      { namespace: 'custom', key: 'download_pdf_file', type: 'url', value: 'https://cdn.shopify.com/s/files/1/0680/4606/1707/files/TAU5.pdf?v=1775454511' },
    ],
  };

  const tauItem = evaluateProduct(tau5, { sku: 'TAU5', title: 'Agar Taurus Laundry Detergent 5L' }, list);
  assert.ok(tauItem, 'TAU5 must qualify (empty productType, category carried by tag/collection)');
  assert.strictEqual(tauItem.sku, 'TAU5');
  assert.strictEqual(tauItem.productName, 'Agar Taurus Laundry Detergent 5L');
  assert.strictEqual(tauItem.sdsUrl, 'https://cdn.shopify.com/s/files/1/0680/4606/1707/files/TAU5.pdf?v=1775454511');

  // same product with the SDS metafield emptied -> no row
  const noSds = { ...tau5, metafield: { namespace: 'custom', key: 'download_pdf_file', type: 'url', value: '' }, metafields: [] };
  assert.strictEqual(evaluateProduct(noSds, { sku: 'TAU5' }, list), null, 'empty metafield must not qualify');

  // non-chemical equipment with a populated SDS link -> still no row
  const equipment = { ...tau5, title: 'Sabco Microfibre Cloth Blue', productType: 'Janitorial', tags: ['Cloths'], collections: ['Cloths & Wipes'] };
  assert.strictEqual(evaluateProduct(equipment, { sku: 'SAB-CLOTH' }, list), null, 'non-chemical product must not qualify');

  console.log('ALL UNIT CHECKS PASSED');
  console.log('--- rendered email (text) ---');
  console.log(email.text);
})().catch((e) => {
  console.error('TEST FAILURE:', e);
  process.exit(1);
});
