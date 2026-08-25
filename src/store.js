const fs = require('fs');
const path = require('path');

/**
 * Idempotency store.
 *
 * Shopify may deliver the same webhook more than once (duplicates or
 * retries), so we remember processed deliveries and skip repeats.
 *
 * We now ALSO remember which ORDERS have already had their SDS email sent
 * (order id), so that two different topics firing for the same order
 * (orders/fulfilled AND orders/paid) cannot produce two emails.
 *
 * The default implementation persists to a JSON file. For production at
 * scale, replace this class with a real database (SQL/Redis) or Shopify's
 * app storage — the interface stays the same.
 */
class JsonStore {
  constructor(file) {
    this.file =
      file ||
      process.env.PROCESSED_ORDERS_FILE ||
      path.join(__dirname, '..', 'data', 'processed-orders.json');
    this.processed = []; // webhook delivery ids already handled
    this.sentOrders = []; // order ids already emailed
    this._load();
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.processed = Array.isArray(parsed.processedDeliveryIds)
        ? parsed.processedDeliveryIds
        : Array.isArray(parsed.processedOrderIds) // backwards compat with v1 file
          ? parsed.processedOrderIds
          : [];
      this.sentOrders = Array.isArray(parsed.sentOrderIds)
        ? parsed.sentOrderIds
        : [];
    } catch {
      this.processed = [];
      this.sentOrders = [];
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(
      this.file,
      JSON.stringify({ processedDeliveryIds: this.processed, sentOrderIds: this.sentOrders }, null, 2)
    );
  }

  /** True if this webhook delivery id was already processed. */
  has(deliveryId) {
    return this.processed.includes(String(deliveryId));
  }

  /** Mark a webhook delivery id as processed. */
  mark(deliveryId) {
    if (!this.has(deliveryId)) {
      this.processed.push(String(deliveryId));
      this._save();
    }
  }

  /** True if an SDS email was already sent for this order id. */
  orderSent(orderId) {
    return this.sentOrders.includes(String(orderId));
  }

  /** Mark an order id as emailed (prevents cross-topic duplicates). */
  markOrderSent(orderId) {
    if (!this.orderSent(orderId)) {
      this.sentOrders.push(String(orderId));
      this._save();
    }
  }
}

module.exports = { JsonStore };
