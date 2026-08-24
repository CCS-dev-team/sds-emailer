const fs = require('fs');
const path = require('path');

/**
 * Idempotency store.
 *
 * Shopify may deliver the same webhook more than once (duplicates or
 * retries), so we remember processed deliveries and skip repeats.
 *
 * The default implementation persists processed webhook ids to a JSON file.
 * For production at scale, replace this class with a real database
 * (SQL/Redis) or Shopify's app storage — the interface stays the same.
 */
class JsonStore {
  constructor(file) {
    this.file =
      file ||
      process.env.PROCESSED_ORDERS_FILE ||
      path.join(__dirname, '..', 'data', 'processed-orders.json');
    this.processed = [];
    this._load();
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.processed = Array.isArray(parsed.processedOrderIds)
        ? parsed.processedOrderIds
        : [];
    } catch {
      this.processed = [];
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(
      this.file,
      JSON.stringify({ processedOrderIds: this.processed }, null, 2)
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
}

module.exports = { JsonStore };
