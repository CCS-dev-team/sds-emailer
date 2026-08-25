/* Lightweight sanity checks (no external deps) for template + category logic. */
const assert = require('assert');
(async () => {
const { renderSdsEmail, DEFAULT_CATEGORIES } = require('../src/template');
const {
  resolveSdsUrl,
  matchesCategory,
  findSdsItems,
  findSdsMetafield,
  evaluateProduct,
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

// ---- 7. Category matching: tags + substring + case-insensitive ----
const catsLower = ['chemicals', 'odour control', 'eco friendly chemicals', 'hand sanitiser', 'hand soap', 'hand wipes'];
assert.ok(matchesCategory({ productType: '', collections: [], tags: ['Cleaning Chemicals'] }, catsLower), 'tag CleaCleaning Chemicals should match Chemicals');
assert.ok(matchesCategory({ productType: '', collections: ['Cleaning Chemicals'], tags: [] }, catsLower), 'collection Cleaning Chemicals should match Chemicals');
assert.ok(matchesCategory({ productType: 'Janitorial', collections: ['Mops'], tags: ['HAND SANITISER GEL'] }, catsLower), 'case-insensitive tag should match Hand Sanitiser');
assert.ok(!matchesCategory({ productType: 'Janitorial', collections: ['Mops'], tags: ['Brooms'] }, catsLower), 'Brooms should not match');

// ---- 8. Metafield fallback scan (exact custom.download_pdf_file first) ----
const found = findSdsMetafield([
  { namespace: 'custom', key: 'download_pdf', type: 'url', value: 'https://cdn.example.com/sds/tau5.pdf' },
]);
assert.strictEqual(found.key, 'download_pdf');
assert.strictEqual(findSdsMetafield([{ namespace: 'custom', key: 'description', type: 'single_line_text_field', value: 'x' }]), null);
const customExact = findSdsMetafield([
  { namespace: 'custom', key: 'download_pdf_file', type: 'url', value: 'https://cdn.example.com/a.pdf' },
  { namespace: 'custom', key: 'download_pdf', type: 'url', value: 'https://cdn.example.com/b.pdf' },
]);
assert.strictEqual(customExact.key, 'download_pdf_file', 'exact custom.download_pdf_file must win');

// ---- 9. Real fixture: TAU5 (Agar Taurus Laundry Detergent 5L) ----
// Pasted verbatim from Shopify (products query) and saved to test/fixtures.
// This is a production store's real product shape, treated as the spec.
const tau5Node = require('./fixtures/tau5-product.json');
const tau5Product = {
  id: tau5Node.id,
  title: tau5Node.title,
  productType: tau5Node.productType || '',
  tags: tau5Node.tags || [],
  collections: (tau5Node.collections.edges || []).map((e) => e.node.title),
  metafield: tau5Node.metafield || null,
  metafields: (tau5Node.metafields.edges || []).map((e) => ({
    namespace: e.node.namespace,
    key: e.node.key,
    type: e.node.type,
    value: e.node.value,
    reference: e.node.reference,
  })),
};
const TAU5_PDF = 'https://cdn.shopify.com/s/files/1/0680/4606/1707/files/TAU5.pdf?v=1775454511';

// 9a. Empty productType -> category falls back to tags/collections; the tag
//     "Cleaning Chemicals" matches "Chemicals" via substring.
const tau5Item = evaluateProduct(
  tau5Product,
  { title: 'Agar Taurus Laundry Detergent 5L', sku: 'TAU5', productId: tau5Product.id },
  catsLower
);
assert.ok(tau5Item, 'TAU5 must qualify (tag/collection Chemicals + SDS metafield)');
assert.strictEqual(tau5Item.sku, 'TAU5');
assert.strictEqual(tau5Item.productName, 'Agar Taurus Laundry Detergent 5L');
assert.strictEqual(tau5Item.sdsUrl, TAU5_PDF, 'exact TAU5.pdf URL must be extracted');

// 9b. The SDS source is custom.download_pdf_file, type url.
const tau5Mf = findSdsMetafield(tau5Product.metafields);
assert.strictEqual(tau5Mf && tau5Mf.key, 'download_pdf_file');
assert.strictEqual(tau5Mf && tau5Mf.namespace, 'custom');
assert.strictEqual(tau5Mf && tau5Mf.type, 'url');
assert.strictEqual(resolveSdsUrl(tau5Mf), TAU5_PDF);

// 9c. rich_text_field JSON values must never be treated as SDS URLs,
//     and MediaImage file_references with no url must not match either.
assert.strictEqual(
  resolveSdsUrl(tau5Product.metafields.find((m) => m.key === 'industrie')),
  null
);
assert.strictEqual(
  resolveSdsUrl(tau5Product.metafields.find((m) => m.key === 'logo_image')),
  null
);
const tau5WithoutPdf = tau5Product.metafields.filter((m) => m.key !== 'download_pdf_file');
assert.strictEqual(findSdsMetafield(tau5WithoutPdf), null);

// ---- 10. Audit report: SDS products matched vs skipped ----
const { buildReport } = require('../src/auditCatalog');
const solventProduct = {
  id: 'gid://shopify/Product/999',
  title: 'Industrial Solvent 5L',
  productType: '',
  tags: ['Degreasers'],
  collections: ['Solvents'],
  metafield: null,
  metafields: [
    { namespace: 'custom', key: 'download_pdf_file', type: 'url', value: 'https://cdn.example.com/sol.pdf' },
  ],
};
const report = buildReport([tau5Product, solventProduct], catsLower);
assert.strictEqual(report.total, 2);
assert.strictEqual(report.withSds, 2);
assert.strictEqual(report.matchCount, 1, 'TAU5 matches; solvent does not');
assert.strictEqual(report.skipCount, 1);
assert.ok(report.skipped.find((p) => p.title === 'Industrial Solvent 5L'));
assert.ok(report.unmatchedTerms.tags.has('degreasers'));
assert.ok(report.unmatchedTerms.collections.has('solvents'));
assert.ok(report.matchedTerms.tags.has('cleaning chemicals'));

// ---- 6. Idempotency store: delivery dedupe + order-level (cross-topic) guard ----
const os = require('os');
const path = require('path');
const fs = require('fs');
const { JsonStore } = require('../src/store');
const tmpFile = path.join(os.tmpdir(), `sds-store-test-${Date.now()}.json`);
const s = new JsonStore(tmpFile);
assert.strictEqual(s.has('delivery-1'), false);
s.mark('delivery-1');
assert.strictEqual(s.has('delivery-1'), true);
assert.strictEqual(s.orderSent('order-42'), false);
s.markOrderSent('order-42');
assert.strictEqual(s.orderSent('order-42'), true);
assert.strictEqual(s.orderSent('12345'), false);
const sReloaded = new JsonStore(tmpFile); // persists across instances
assert.strictEqual(sReloaded.has('delivery-1'), true);
assert.strictEqual(sReloaded.orderSent('order-42'), true);
try { fs.unlinkSync(tmpFile); } catch {}

console.log('ALL UNIT CHECKS PASSED');
console.log('--- rendered email (text) ---');
console.log(email.text);
})().catch((e) => { console.error('TEST FAILURE:', e); process.exit(1); });
