const DEFAULT_CATEGORIES = [
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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders the SDS email exactly as specified by Central Cleaning Supplies.
 *
 * Email title: "Safety Data Sheets (SDS) for your recent chemical purchase"
 *
 * @param {object} options
 * @param {string} options.firstName  Customer first name (falls back to "there")
 * @param {Array<{productName: string, sku: string, sdsUrl: string}>} options.items
 * @returns {{subject: string, text: string, html: string}}
 */
function renderSdsEmail({ firstName, items }) {
  const name = firstName && firstName.trim() ? firstName.trim() : 'there';

  const rows = items
    .map((i) => `${i.productName} ${i.sku} - ${i.sdsUrl}`.replace(/\s+/g, ' ').trim())
    .join('\n');

  const subject = 'Safety Data Sheets (SDS) for your recent chemical purchase';

  const text = `Hi ${name},

Thank you for your recent order with Central Cleaning Supplies.

Because your order includes a chemical product, we have forwarded you links to download the relevant Safety Data Sheet (SDS) for your reference.

The SDS contains important information about the product, including:

Safe handling and storage requirements

First-aid and emergency measures

Personal protective equipment recommendations

Spill, disposal, and transport guidance

${rows}

Please ensure the SDS is made available to any person who will store, handle, or use this product. We recommend keeping a copy accessible in your workplace or cleaning area.

If you have any questions about the product or need assistance locating a current SDS, please contact our team.

Kind regards,
Central Cleaning Supplies`;

  const htmlRows = items
    .map((i) => {
      const label = `${i.productName} ${i.sku}`.replace(/\s+/g, ' ').trim();
      return (
        `  <li>${escapeHtml(label)} &mdash; ` +
        `<a title="View SDS" href="${escapeHtml(i.sdsUrl)}" target="_blank">View SDS</a></li>`
      );
    })
    .join('\n');

  const html = `<p>Hi ${escapeHtml(name)},</p>
<p>Thank you for your recent order with Central Cleaning Supplies.</p>
<p>Because your order includes a chemical product, we have forwarded you links to download the relevant Safety Data Sheet (SDS) for your reference.</p>
<p>The SDS contains important information about the product, including:</p>
<ul>
  <li>Safe handling and storage requirements</li>
  <li>First-aid and emergency measures</li>
  <li>Personal protective equipment recommendations</li>
  <li>Spill, disposal, and transport guidance</li>
</ul>
<ul>
${htmlRows}
</ul>
<p>Please ensure the SDS is made available to any person who will store, handle, or use this product. We recommend keeping a copy accessible in your workplace or cleaning area.</p>
<p>If you have any questions about the product or need assistance locating a current SDS, please contact our team.</p>
<p>Kind regards,<br/>Central Cleaning Supplies</p>`;

  return { subject, text, html };
}

module.exports = { renderSdsEmail, DEFAULT_CATEGORIES };

