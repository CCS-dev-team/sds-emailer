const crypto = require('crypto');

/**
 * Verify a Shopify webhook delivery.
 *
 * Shopify signs every HTTPS delivery with HMAC-SHA256 of the RAW request
 * body, using your app's API secret as the key, and sends the base64 digest
 * in the `X-Shopify-Hmac-SHA256` header.
 *
 * @param {Buffer|string} rawBody  The raw, unparsed request body bytes.
 * @param {string} hmacHeader      Value of the X-Shopify-Hmac-SHA256 header.
 * @param {string} apiSecret       Your app's API secret (SHOPIFY_API_SECRET).
 * @returns {boolean}
 */
function verifyWebhook(rawBody, hmacHeader, apiSecret) {
  if (!hmacHeader || !apiSecret) return false;

  const expected = crypto
    .createHmac('sha256', apiSecret)
    .update(rawBody, 'utf8')
    .digest('base64');

  const a = Buffer.from(expected);
  const b = Buffer.from(hmacHeader);

  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { verifyWebhook };
