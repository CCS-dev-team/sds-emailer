/**
 * Register / repair the webhook subscriptions on your store.
 *
 *   node src/registerWebhook.js              # create, repair and de-duplicate
 *   node src/registerWebhook.js --dry-run    # report what would change, change nothing
 *   node src/registerWebhook.js --no-prune   # create/repair but never delete extras
 *   node src/registerWebhook.js --help
 *
 * Safe to run as often as you like — it is IDEMPOTENT:
 *   - subscription missing            -> created
 *   - subscription on the wrong path  -> updated in place (keeps its id)
 *   - subscription already correct    -> skipped ("already correct")
 *   - duplicate subscriptions         -> extras deleted (unless --no-prune)
 *
 * Subscribes to:
 *   ORDERS_PAID      - fires when payment is captured
 *   ORDERS_FULFILLED - fires when the order is fulfilled / goods dispatched.
 *                      This is the topic src/server.js actually sends the SDS
 *                      email on by default (SDS_TRIGGER_TOPICS defaults to
 *                      orders/fulfilled). Both topics stay subscribed so that
 *                      paid deliveries are still answered with a valid 200 and
 *                      Shopify never retires the subscription.
 *
 * Each topic is delivered to its OWN path on the same origin, matching the
 * routes in src/server.js:
 *   POST /webhooks/orders/paid
 *   POST /webhooks/orders/fulfilled
 * The handler keys off the X-Shopify-Topic header, so a shared URL would also
 * work — per-topic paths keep the Shopify UI, the Render logs and the
 * diagnose-order output readable.
 *
 * Only the ORIGIN of WEBHOOK_CALLBACK_URL is used, so an existing
 * .../webhooks/orders/paid value keeps working unchanged.
 *
 * Requires in .env:
 *   SHOPIFY_SHOP_DOMAIN, WEBHOOK_CALLBACK_URL, and valid auth
 *   (SHOPIFY_ADMIN_ACCESS_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
 *   for the client-credentials grant).
 *
 * GraphQL note: recent Admin API versions renamed the subscription endpoint
 * field from `callbackUrl` to `uri` in WebhookSubscriptionInput. This script
 * probes which field the store's API version accepts and uses that one
 * everywhere, so it works on both old and new versions.
 */
require('dotenv').config();

const { getAdminAccessToken } = require('./auth');

const REQUEST_TIMEOUT_MS = Number(process.env.SHOPIFY_TIMEOUT_MS || 10000) || 10000;

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const NO_PRUNE = argv.includes('--no-prune');

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Usage: node src/registerWebhook.js [--dry-run] [--no-prune]

  (no flags)   Create missing subscriptions, repair wrong callback URLs,
               delete duplicate subscriptions for the same topic.
  --dry-run    Print what would change; makes no changes.
  --no-prune   Never delete anything (duplicates are only reported).
`);
  process.exit(0);
}

const shop = process.env.SHOPIFY_SHOP_DOMAIN;
const version = process.env.SHOPIFY_API_VERSION || '2026-07';

/** Each topic is delivered to its own path (must match src/server.js routes). */
const TOPIC_PATHS = {
  ORDERS_PAID: '/webhooks/orders/paid',
  ORDERS_FULFILLED: '/webhooks/orders/fulfilled',
};

const TOPICS = Object.keys(TOPIC_PATHS);

/** Build the per-topic callback URL from the origin of WEBHOOK_CALLBACK_URL. */
function callbackUrlFor(topic) {
  const base = process.env.WEBHOOK_CALLBACK_URL;
  if (!base) throw new Error('WEBHOOK_CALLBACK_URL is missing from .env');
  const origin = new URL(base).origin;
  return `${origin}${TOPIC_PATHS[topic]}`;
}

/** Compare URLs ignoring a trailing slash and letter case in host/scheme. */
function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return String(url).trim().replace(/\/+$/, '').toLowerCase();
  }
}

/**
 * One Admin GraphQL request. Returns { ok, status, data, errors } and never
 * throws on a non-JSON body (Render/proxy error pages used to crash the old
 * script on res.json()).
 */
async function graphql(token, query, variables) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    const res = await fetch(`https://${shop}/admin/api/${version}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      return {
        ok: false,
        status: res.status,
        data: null,
        errors: [
          {
            message: `Non-JSON response (HTTP ${res.status}): ${text.slice(0, 200) || '<empty body>'}`,
          },
        ],
      };
    }

    const errors = (body && body.errors) || [];
    return { ok: res.ok && errors.length === 0, status: res.status, data: body && body.data, errors };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.name === 'ABORT_ERR');
    return {
      ok: false,
      status: 0,
      data: null,
      errors: [
        {
          message: aborted
            ? `Request timed out after ${REQUEST_TIMEOUT_MS}ms (raise SHOPIFY_TIMEOUT_MS if needed)`
            : `Request failed: ${err.message}`,
        },
      ],
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Work out which field name this API version uses for the endpoint URL:
 * `uri` (current) or `callbackUrl` (older / deprecated).
 */
async function detectUrlField(token) {
  for (const field of ['uri', 'callbackUrl']) {
    const r = await graphql(
      token,
      `query ProbeUrlField { webhookSubscriptions(first: 1) { nodes { id ${field} } } }`
    );
    if (r.ok) return field;
  }
  throw new Error(
    'Could not read webhook subscriptions — check the access token scopes (read_webhooks is not required, but the token must be valid).'
  );
}

async function listSubscriptions(token, urlField) {
  const r = await graphql(
    token,
    `query ExistingSubscriptions {
       webhookSubscriptions(first: 100) {
         nodes { id topic ${urlField} format apiVersion { handle } }
       }
     }`
  );
  if (!r.ok) {
    const detail = r.errors.map((e) => e.message).join('; ');
    throw new Error(`Could not list webhook subscriptions: ${detail}`);
  }
  const nodes = (r.data && r.data.webhookSubscriptions && r.data.webhookSubscriptions.nodes) || [];
  return nodes.map((n) => ({
    id: n.id,
    topic: n.topic,
    url: n[urlField] || n.uri || n.callbackUrl || '',
    format: n.format,
    apiVersion: n.apiVersion && n.apiVersion.handle,
  }));
}

async function createSubscription(token, urlField, topic, url) {
  const r = await graphql(
    token,
    `mutation WebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $url: URL!) {
       webhookSubscriptionCreate(
         topic: $topic
         webhookSubscription: { ${urlField}: $url }
       ) {
         webhookSubscription { id topic ${urlField} format apiVersion { handle } }
         userErrors { field message }
       }
     }`,
    { topic, url }
  );

  const payload = r.data && r.data.webhookSubscriptionCreate;
  const userErrors = (payload && payload.userErrors) || [];
  if (userErrors.length || !payload || !payload.webhookSubscription) {
    return { ok: false, errors: userErrors.length ? userErrors : r.errors };
  }
  return { ok: true, subscription: payload.webhookSubscription };
}

async function updateSubscriptionUrl(token, urlField, id, url) {
  const r = await graphql(
    token,
    `mutation WebhookSubscriptionUpdate($id: ID!, $url: URL!) {
       webhookSubscriptionUpdate(id: $id, webhookSubscription: { ${urlField}: $url }) {
         webhookSubscription { id topic ${urlField} format apiVersion { handle } }
         userErrors { field message }
       }
     }`,
    { id, url }
  );

  const payload = r.data && r.data.webhookSubscriptionUpdate;
  const userErrors = (payload && payload.userErrors) || [];
  if (userErrors.length || !payload || !payload.webhookSubscription) {
    return { ok: false, errors: userErrors.length ? userErrors : r.errors };
  }
  return { ok: true, subscription: payload.webhookSubscription };
}

async function deleteSubscription(token, id) {
  const r = await graphql(
    token,
    `mutation WebhookSubscriptionDelete($id: ID!) {
       webhookSubscriptionDelete(id: $id) {
         deletedWebhookSubscriptionId
         userErrors { field message }
       }
     }`,
    { id }
  );

  const payload = r.data && r.data.webhookSubscriptionDelete;
  const userErrors = (payload && payload.userErrors) || [];
  if (userErrors.length || !payload) {
    return { ok: false, errors: userErrors.length ? userErrors : r.errors };
  }
  return { ok: true, deletedId: payload.deletedWebhookSubscriptionId };
}

/** Print GraphQL/user errors in a readable way. */
function printErrors(label, errors) {
  console.error(`${label}:`);
  for (const e of errors || []) {
    const field = Array.isArray(e.field) ? e.field.join('.') : e.field;
    console.error(`  - ${field ? `${field}: ` : ''}${e.message}`);
  }
}

(async () => {
  const base = process.env.WEBHOOK_CALLBACK_URL;

  if (!shop || !base) {
    console.error('Missing SHOPIFY_SHOP_DOMAIN or WEBHOOK_CALLBACK_URL in .env');
    process.exitCode = 1;
    return;
  }

  if (!/^https:\/\//i.test(base)) {
    console.error('WEBHOOK_CALLBACK_URL must be an HTTPS URL.');
    process.exitCode = 1;
    return;
  }

  console.log(`Shop:    ${shop}`);
  console.log(`API:     ${version}`);
  console.log(
    `Auth:    ${
      process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
        ? 'explicit SHOPIFY_ADMIN_ACCESS_TOKEN'
        : 'client-credentials grant'
    }`
  );
  console.log(`Mode:    ${DRY_RUN ? 'DRY RUN (no changes)' : 'apply'}${NO_PRUNE ? ', --no-prune' : ''}`);
  for (const t of TOPICS) console.log(`Target:  ${t} -> ${callbackUrlFor(t)}`);
  console.log('');

  try {
    // OAuth access token (production store) or client-credentials grant —
    // either way, auth.js returns a valid Admin API access token.
    const adminToken = await getAdminAccessToken();

    const urlField = await detectUrlField(adminToken);
    console.log(`Endpoint field for this version: ${urlField}\n`);

    const existing = await listSubscriptions(adminToken, urlField);
    const summary = [];
    let failed = false;

    for (const topic of TOPICS) {
      const desired = callbackUrlFor(topic);
      const desiredKey = normalizeUrl(desired);
      const mine = existing.filter((s) => s.topic === topic);
      const correct = mine.filter((s) => normalizeUrl(s.url) === desiredKey);
      const wrong = mine.filter((s) => normalizeUrl(s.url) !== desiredKey);

      if (correct.length > 0) {
        // Already right — keep the first, remove the rest.
        summary.push({ topic, action: 'already correct', id: correct[0].id, url: desired });

        const extras = [...correct.slice(1), ...wrong];
        if (extras.length === 0) continue;

        if (NO_PRUNE) {
          console.log(`Note: ${topic} has ${extras.length} extra subscription(s) — left alone (--no-prune).`);
          for (const s of extras) summary.push({ topic, action: 'extra (kept)', id: s.id, url: s.url });
          continue;
        }

        for (const s of extras) {
          if (DRY_RUN) {
            summary.push({ topic, action: 'would delete extra', id: s.id, url: s.url });
            continue;
          }
          const del = await deleteSubscription(adminToken, s.id);
          if (del.ok) {
            summary.push({ topic, action: 'deleted extra', id: s.id, url: s.url });
          } else {
            failed = true;
            printErrors(`Failed to delete extra ${topic} ${s.id}`, del.errors);
            summary.push({ topic, action: 'delete FAILED', id: s.id, url: s.url });
          }
        }
        continue;
      }

      if (wrong.length > 0) {
        // Exists but points somewhere else — update in place, keep its id.
        const target = wrong[0];
        if (DRY_RUN) {
          summary.push({ topic, action: 'would update URL', id: target.id, url: desired });
        } else {
          const upd = await updateSubscriptionUrl(adminToken, urlField, target.id, desired);
          if (upd.ok) {
            summary.push({ topic, action: 'updated URL', id: target.id, url: desired });
          } else {
            failed = true;
            printErrors(`Failed to update ${topic} ${target.id}`, upd.errors);
            summary.push({ topic, action: 'update FAILED', id: target.id, url: target.url });
          }
        }

        // Any additional duplicates for the same topic are surplus.
        const extras = wrong.slice(1);
        if (extras.length > 0 && !NO_PRUNE) {
          for (const s of extras) {
            if (DRY_RUN) {
              summary.push({ topic, action: 'would delete extra', id: s.id, url: s.url });
              continue;
            }
            const del = await deleteSubscription(adminToken, s.id);
            if (del.ok) {
              summary.push({ topic, action: 'deleted extra', id: s.id, url: s.url });
            } else {
              failed = true;
              printErrors(`Failed to delete extra ${topic} ${s.id}`, del.errors);
              summary.push({ topic, action: 'delete FAILED', id: s.id, url: s.url });
            }
          }
        } else if (extras.length > 0) {
          for (const s of extras) summary.push({ topic, action: 'extra (kept)', id: s.id, url: s.url });
        }
        continue;
      }

      // Nothing registered for this topic yet.
      if (DRY_RUN) {
        summary.push({ topic, action: 'would create', id: '(new)', url: desired });
        continue;
      }

      const created = await createSubscription(adminToken, urlField, topic, desired);
      if (created.ok) {
        const sub = created.subscription;
        summary.push({ topic, action: 'created', id: sub.id, url: sub[urlField] || desired });
      } else {
        failed = true;
        printErrors(`Webhook registration failed (${topic})`, created.errors);
        summary.push({ topic, action: 'create FAILED', id: '-', url: desired });
      }
    }

    console.log('Summary');
    console.log('-------');
    for (const row of summary) {
      console.log(`${row.topic.padEnd(18)} ${row.action.padEnd(18)} ${row.id}`);
      console.log(`${''.padEnd(18)} ${row.url}`);
    }

    if (DRY_RUN) {
      console.log('\nDry run only — nothing was changed. Re-run without --dry-run to apply.');
    } else if (!failed) {
      console.log('\nDone. Verify with:  node test\\diagnose-order.js <order-name>');
    }

    if (failed) process.exitCode = 1;
  } catch (err) {
    console.error(err.message || err);
    process.exitCode = 1;
  }
})();
