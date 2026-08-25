const sgMail = require('@sendgrid/mail');
const { renderSdsEmail } = require('./template');

/** Configure the SendGrid client with your API key (called once at boot). */
function initSendGrid() {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    throw new Error('SENDGRID_API_KEY is not set in .env');
  }
  sgMail.setApiKey(apiKey);
}

/**
 * Build the SendGrid message for the SDS email (pure — no I/O, unit-testable).
 *
 * Sender identity: SENDGRID_FROM is the authenticated envelope address (must
 * stay a verified sender so SPF/DKIM pass); SENDGRID_FROM_NAME is the display
 * name recipients see, defaulting to "Central Cleaning Supplies".
 *
 * Click tracking: disabled per message so SendGrid does NOT rewrite links into
 * "url<id>.<domain>/ls/click?... " wrappers — SDS links are sent as raw
 * canonical URLs and open directly.
 */
function buildSdsMessage({ to, firstName, items, from, fromName }) {
  const { subject, text, html } = renderSdsEmail({ firstName, items });

  return {
    to,
    from: { email: from, name: fromName },
    subject,
    text,
    html,
    mailSettings: {
      clickTracking: { enable: false, enableText: false },
    },
  };
}

/**
 * Send the SDS email for one order.
 *
 * @param {object} options
 * @param {string} options.to         Customer email address
 * @param {string} options.firstName  Customer first name (fallback "there")
 * @param {Array<{productName: string, sku: string, sdsUrl: string}>} options.items
 */
async function sendSdsEmail({ to, firstName, items }) {
  const from = process.env.SENDGRID_FROM;
  if (!from) {
    throw new Error('SENDGRID_FROM is not set in .env');
  }
  const fromName = process.env.SENDGRID_FROM_NAME || 'Central Cleaning Supplies';

  return sgMail.send(buildSdsMessage({ to, firstName, items, from, fromName }));
}

module.exports = { initSendGrid, sendSdsEmail, buildSdsMessage };
