/* Lightweight sanity checks (no external deps) for template + category logic. */
const assert = require('assert');
(async () => {
const { renderSdsEmail, DEFAULT_CATEGORIES } = require('../src/template');
const {
  resolveSdsUrl,
  matchesCategory,
  findSdsItems,
} = require('../src/sds');

// ---- 1. Email template matches the user's wording exactly ----
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
assert.ok(email.text.includes('Because your order includes a chemical product, we have forwarded you links to download the relevant Safety Data Sheet (SDS) for your reference.'));
assert.ok(email.text.includes('Safe handling and storage requirements'));
assert.ok(email.text.includes('First-aid and emergency measures'));
assert.ok(email.text.includes('Personal protective equipment recommendations'));
assert.ok(email.text.includes('Spill, disposal, and transport guidance'));
assert.ok(email.text.includes('Citrus Degreaser 5L CD-5L - https://cdn.example.com/sds/cd5l.pdf'));
assert.ok(email.text.includes('Hand Sanitiser Gel 500ml HSG-500 - https://cdn.example.com/sds/hsg.pdf'));
assert.ok(email.text.includes('Please ensure the SDS is made available to any person who will store, handle, or use this product. We recommend keeping a copy accessible in your workplace or cleaning area.'));
assert.ok(email.text.includes('If you have any questions about the product or need assistance locating a current SDS, please contact our team.'));
assert.ok(email.text.includes('Kind regards,\nCentral Cleaning Supplies'));

// fallback first name
const noName = renderSdsEmail({ firstName: '', items: [{ productName: 'Citrus Degreaser 5L', sku: 'CD-5L', sdsUrl: 'https://cdn.example.com/sds/cd5l.pdf' }] });
assert.ok(noName.text.includes('Hi there,'));
assert.ok(noName.html.includes('Hi there,'));

// ---- 2. Default categories exactly the six required ----
assert.deepStrictEqual(DEFAULT_CATEGORIES, [
  'Chemicals',
  'Odour Control',
  'Eco Friendly Chemicals',
  'Hand Sanitiser',
  'Hand Soap',
  'Hand Wipes',
]);

// ---- 3. Category matching: product type AND collection titles, case-insensitive ----
assert.ok(matchesCategory({ productType: 'Chemicals', collections: [] }, DEFAULT_CATEGORIES.map((c) => c.toLowerCase())));
assert.ok(matchesCategory({ productType: 'Cleaning', collections: ['Odour Control'] }, DEFAULT_CATEGORIES.map((c) => c.toLowerCase())));
assert.ok(matchesCategory({ productType: '', collections: ['hand sanitiser'] }, DEFAULT_CATEGORIES.map((c) => c.toLowerCase())));
assert.ok(!matchesCategory({ productType: 'Janitorial', collections: ['Mops'] }, DEFAULT_CATEGORIES.map((c) => c.toLowerCase())));

// ---- 4. Metafield resolution: url type, file_reference type, empty ----
assert.strictEqual(
  resolveSdsUrl({ value: 'https://cdn.example.com/a.pdf', type: 'url' }),
  'https://cdn.example.com/a.pdf'
);
assert.strictEqual(
  resolveSdsUrl({ value: 'gid://shopify/GenericFile/123', type: 'file_reference', reference: { url: 'https://cdn.shopify.com/s/files/a.pdf' } }),
  'https://cdn.shopify.com/s/files/a.pdf'
);
assert.strictEqual(resolveSdsUrl(null), null);
assert.strictEqual(resolveSdsUrl({ value: '', type: 'url' }), null);
assert.strictEqual(resolveSdsUrl({ value: 'gid://shopify/GenericFile/9', type: 'file_reference', reference: null }), null);

// ---- 5. findSdsItems: no qualifying items -> empty ----
const empty = await findSdsItems('store.myshopify.com', 'tok', { lineItems: [] });
assert.deepStrictEqual(empty, []);

console.log('ALL UNIT CHECKS PASSED');
console.log('--- rendered email (text) ---');
console.log(email.text);
})().catch((e) => { console.error('TEST FAILURE:', e); process.exit(1); });
