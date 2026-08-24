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

  const { subject, text, html } = renderSdsEmail({ firstName, items });

  const msg = {
    to,
    from: { email: from },
    subject,
    text,
    html,
  };

  return sgMail.send(msg);
}

module.exports = { initSendGrid, sendSdsEmail };
