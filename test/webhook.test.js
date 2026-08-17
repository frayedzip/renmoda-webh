// End-to-end webhook test with correctly-signed payloads. Shopify + Razorpay
// customer-fetch are mocked; the real signature verification, dedupe store, and
// membership logic run.
//
//   node --test test/*.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/lib/config.js';
import { createStore } from '../src/db/store.js';
import { createRazorpayService } from '../src/services/razorpay.js';
import { createMembershipService } from '../src/services/membership.js';
import { createApp } from '../src/server.js';

const WEBHOOK_SECRET = 'test_webhook_secret';
const PLANS_FIXTURE = fileURLToPath(new URL('./plans.fixture.json', import.meta.url));

const TEST_ENV = {
  PORT: '3000',
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'rzp_test_secret',
  RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  SHOPIFY_SHOP: 'renmoda-test.myshopify.com',
  SHOPIFY_ADMIN_TOKEN: 'shpat_test',
  JOIN_SUCCESS_URL: 'https://renmoda.example/thanks',
  JOIN_FAILURE_URL: 'https://renmoda.example/sorry',
  DB_PATH: ':memory:',
  PLANS_PATH: PLANS_FIXTURE,
};

// In-memory Shopify: customers keyed by email, tags per customer gid.
function createShopifyMock() {
  const calls = [];
  const customers = new Map(); // email -> gid
  const tags = new Map(); // gid -> Set<tag>
  let seq = 0;

  const svc = {
    calls,
    tagsOf(gid) {
      return [...(tags.get(gid) ?? [])];
    },
    gidForEmail(email) {
      return customers.get(email) ?? null;
    },
    async findCustomerByEmail(email) {
      calls.push({ op: 'findCustomerByEmail', email });
      return customers.get(email) ?? null;
    },
    async createCustomer(email) {
      calls.push({ op: 'createCustomer', email });
      const gid = `gid://shopify/Customer/${1000 + ++seq}`;
      customers.set(email, gid);
      return gid;
    },
    async sendAccountInvite(gid) {
      calls.push({ op: 'sendAccountInvite', gid });
      return { sent: true };
    },
    async findOrCreateCustomer(email) {
      const existing = customers.get(email);
      if (existing) return { gid: existing, created: false };
      const gid = await svc.createCustomer(email);
      const invite = await svc.sendAccountInvite(gid);
      return { gid, created: true, invite };
    },
    // Seeds a customer with pre-existing tags (e.g. non-membership ones).
    seed(email, seedTags) {
      const gid = `gid://shopify/Customer/${1000 + ++seq}`;
      customers.set(email, gid);
      tags.set(gid, new Set(seedTags));
      return gid;
    },
    async addTag(gid, tag) {
      calls.push({ op: 'addTag', customerGid: gid, tag });
      if (!tags.has(gid)) tags.set(gid, new Set());
      tags.get(gid).add(tag);
      return [...tags.get(gid)];
    },
    async removeTags(gid, list) {
      calls.push({ op: 'removeTags', customerGid: gid, tags: list });
      for (const tag of list) tags.get(gid)?.delete(tag);
      return [...(tags.get(gid) ?? [])];
    },
  };
  return svc;
}

function sign(body) {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
}

function chargedPayload({
  email = 'member@example.com',
  customerId = 'cust_test1',
  subscriptionId = 'sub_test123',
  planKey = 'gold',
  planTag = 'membership-gold',
  includeTag = true,
  includeEmail = true,
} = {}) {
  const notes = {};
  if (includeTag) {
    notes.plan = planKey;
    notes.plan_tag = planTag;
  }
  const paymentEntity = { id: 'pay_test123', amount: 400000, currency: 'INR' };
  if (includeEmail) paymentEntity.email = email;
  return JSON.stringify({
    entity: 'event',
    event: 'subscription.charged',
    payload: {
      subscription: { entity: { id: subscriptionId, status: 'active', customer_id: customerId, notes } },
      payment: { entity: paymentEntity },
    },
  });
}

function cancelledPayload({
  customerId = 'cust_test1',
  subscriptionId = 'sub_test123',
  planKey = 'gold',
  planTag = 'membership-gold',
} = {}) {
  // No payment entity — identity resolves via the Razorpay customer fetch.
  return JSON.stringify({
    entity: 'event',
    event: 'subscription.cancelled',
    payload: {
      subscription: {
        entity: { id: subscriptionId, status: 'cancelled', customer_id: customerId, notes: { plan: planKey, plan_tag: planTag } },
      },
    },
  });
}

// razorpayEmail may be a value or a function (so a test can make the customer
// fetch throw, the way a Razorpay outage would).
async function startTestServer({ razorpayEmail = 'member@example.com' } = {}) {
  const config = loadConfig(TEST_ENV);
  const logged = [];
  const record = (level) => (msg, fields = {}) => logged.push({ level, msg, ...fields });
  const log = { info: record('info'), warn: record('warn'), error: record('error'), child() { return this; } };
  const store = createStore(':memory:');
  const shopify = createShopifyMock();
  const razorpay = createRazorpayService(config); // real verifyWebhookSignature
  razorpay.fetchCustomerEmail =
    typeof razorpayEmail === 'function' ? razorpayEmail : async () => razorpayEmail; // stub the network call
  const membership = createMembershipService({ config, store, shopify, razorpay, log });

  const waiters = [];
  const onEventProcessed = (err, eventId) => {
    waiters.shift()?.({ err, eventId });
  };
  const nextProcessed = () => new Promise((resolve) => waiters.push(resolve));

  const app = createApp({ config, store, shopify, razorpay, membership, log, onEventProcessed });
  const server = app.listen(0);
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/webhooks/razorpay`;

  return { url, store, shopify, logged, nextProcessed, close: () => server.close() };
}

function post(url, body, headers) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
}

test('charged with a new email: creates the Shopify customer, invites them, tags them', async (t) => {
  const ctx = await startTestServer();
  t.after(ctx.close);

  const body = chargedPayload({ email: 'new@example.com' });
  const processed = ctx.nextProcessed();
  const res = await post(ctx.url, body, { 'x-razorpay-signature': sign(body), 'x-razorpay-event-id': 'evt_new' });

  assert.equal(res.status, 200);
  const { err } = await processed;
  assert.equal(err, null);

  assert.ok(ctx.shopify.calls.some((c) => c.op === 'createCustomer' && c.email === 'new@example.com'));
  assert.ok(ctx.shopify.calls.some((c) => c.op === 'sendAccountInvite'));
  const gid = ctx.shopify.gidForEmail('new@example.com');
  assert.deepEqual(ctx.shopify.tagsOf(gid), ['membership-gold']);
});

test('charged with an existing email: tags only, no duplicate customer or invite', async (t) => {
  const ctx = await startTestServer();
  t.after(ctx.close);

  const body = chargedPayload({ email: 'existing@example.com' });
  const sig = sign(body);

  let processed = ctx.nextProcessed();
  await post(ctx.url, body, { 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt_m1' });
  await processed;

  processed = ctx.nextProcessed();
  await post(ctx.url, body, { 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt_m2' });
  await processed;

  // Created + invited exactly once (first charge); second is find + tag only.
  assert.equal(ctx.shopify.calls.filter((c) => c.op === 'createCustomer').length, 1);
  assert.equal(ctx.shopify.calls.filter((c) => c.op === 'sendAccountInvite').length, 1);
  assert.equal(ctx.shopify.calls.filter((c) => c.op === 'addTag').length, 2);
  const gid = ctx.shopify.gidForEmail('existing@example.com');
  assert.deepEqual(ctx.shopify.tagsOf(gid), ['membership-gold']); // idempotent
});

test('the tag applied matches the plan in notes (silver)', async (t) => {
  const ctx = await startTestServer();
  t.after(ctx.close);

  const body = chargedPayload({ email: 's@example.com', planKey: 'silver', planTag: 'membership-silver' });
  const processed = ctx.nextProcessed();
  await post(ctx.url, body, { 'x-razorpay-signature': sign(body), 'x-razorpay-event-id': 'evt_silver' });
  await processed;

  assert.deepEqual(ctx.shopify.tagsOf(ctx.shopify.gidForEmail('s@example.com')), ['membership-silver']);
});

test('tampered signature: rejected with 401, nothing processed', async (t) => {
  const ctx = await startTestServer();
  t.after(ctx.close);

  const body = chargedPayload();
  const good = sign(body);
  const tampered = (good[0] === 'a' ? 'b' : 'a') + good.slice(1);
  const res = await post(ctx.url, body, { 'x-razorpay-signature': tampered, 'x-razorpay-event-id': 'evt_bad' });

  assert.equal(res.status, 401);
  assert.equal(ctx.shopify.calls.length, 0);
});

test('missing signature: rejected with 401', async (t) => {
  const ctx = await startTestServer();
  t.after(ctx.close);

  const body = chargedPayload();
  const res = await post(ctx.url, body, { 'x-razorpay-event-id': 'evt_nosig' });
  assert.equal(res.status, 401);
  assert.equal(ctx.shopify.calls.length, 0);
});

test('duplicate event id: second delivery ignored', async (t) => {
  const ctx = await startTestServer();
  t.after(ctx.close);

  const body = chargedPayload();
  const headers = { 'x-razorpay-signature': sign(body), 'x-razorpay-event-id': 'evt_dup' };

  const processed = ctx.nextProcessed();
  await post(ctx.url, body, headers);
  await processed;
  const after = ctx.shopify.calls.length;

  const second = await post(ctx.url, body, headers);
  assert.deepEqual(await second.json(), { status: 'duplicate' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ctx.shopify.calls.length, after);
});

test('cancellation: resolves email via the Razorpay customer, removes the tag', async (t) => {
  const ctx = await startTestServer({ razorpayEmail: 'member@example.com' });
  t.after(ctx.close);

  // Grant first (charged carries the email).
  const charged = chargedPayload({ email: 'member@example.com' });
  let processed = ctx.nextProcessed();
  await post(ctx.url, charged, { 'x-razorpay-signature': sign(charged), 'x-razorpay-event-id': 'evt_pre_cancel' });
  await processed;
  const gid = ctx.shopify.gidForEmail('member@example.com');
  assert.deepEqual(ctx.shopify.tagsOf(gid), ['membership-gold']);

  // Cancel has no payment entity — email comes from the (stubbed) customer fetch.
  const cancelled = cancelledPayload();
  processed = ctx.nextProcessed();
  const res = await post(ctx.url, cancelled, { 'x-razorpay-signature': sign(cancelled), 'x-razorpay-event-id': 'evt_cancel' });
  assert.equal(res.status, 200);
  const { err } = await processed;
  assert.equal(err, null);

  assert.deepEqual(ctx.shopify.tagsOf(gid), []); // untagged
  assert.ok(ctx.shopify.calls.some((c) => c.op === 'removeTags' && c.tags.includes('membership-gold')));
});

// The production failure: a grant identifies the member by the PAYMENT email,
// a cancel by the RAZORPAY CUSTOMER email. When those differ, the email lookup
// finds nobody and the tag used to be left on silently.
test('cancellation: Razorpay customer email differs from the payment email — untags via grant history', async (t) => {
  const ctx = await startTestServer({ razorpayEmail: 'different@example.com' });
  t.after(ctx.close);

  const charged = chargedPayload({ email: 'paid-with@example.com' });
  let processed = ctx.nextProcessed();
  await post(ctx.url, charged, { 'x-razorpay-signature': sign(charged), 'x-razorpay-event-id': 'evt_pre_mismatch' });
  await processed;
  const gid = ctx.shopify.gidForEmail('paid-with@example.com');
  assert.deepEqual(ctx.shopify.tagsOf(gid), ['membership-gold']);

  const cancelled = cancelledPayload();
  processed = ctx.nextProcessed();
  await post(ctx.url, cancelled, { 'x-razorpay-signature': sign(cancelled), 'x-razorpay-event-id': 'evt_mismatch' });
  const { err } = await processed;

  assert.equal(err, null);
  assert.deepEqual(ctx.shopify.tagsOf(gid), []); // the tag is actually gone
  assert.ok(ctx.logged.some((l) => l.msg === 'revoke: no Shopify customer matches the Razorpay email'));
  assert.ok(ctx.logged.some((l) => l.msg === 'plan tag revoked' && l.identifiedVia === 'grant_history'));
});

test('cancellation: a failing Razorpay customer fetch still untags via grant history', async (t) => {
  const ctx = await startTestServer({
    razorpayEmail: async () => {
      throw new Error('razorpay 504');
    },
  });
  t.after(ctx.close);

  const charged = chargedPayload({ email: 'outage@example.com' });
  let processed = ctx.nextProcessed();
  await post(ctx.url, charged, { 'x-razorpay-signature': sign(charged), 'x-razorpay-event-id': 'evt_pre_outage' });
  await processed;
  const gid = ctx.shopify.gidForEmail('outage@example.com');

  const cancelled = cancelledPayload();
  processed = ctx.nextProcessed();
  await post(ctx.url, cancelled, { 'x-razorpay-signature': sign(cancelled), 'x-razorpay-event-id': 'evt_outage' });
  const { err } = await processed;

  assert.equal(err, null);
  assert.deepEqual(ctx.shopify.tagsOf(gid), []);
  assert.ok(ctx.logged.some((l) => l.msg === 'revoke: Razorpay customer lookup failed, falling back to grant history'));
});

test('cancellation that can identify nobody fails loudly instead of silently doing nothing', async (t) => {
  const ctx = await startTestServer({ razorpayEmail: 'ghost@example.com' });
  t.after(ctx.close);

  // No prior charge for this subscription, and Shopify has no such customer.
  const cancelled = cancelledPayload({ subscriptionId: 'sub_never_charged' });
  const processed = ctx.nextProcessed();
  const res = await post(ctx.url, cancelled, { 'x-razorpay-signature': sign(cancelled), 'x-razorpay-event-id': 'evt_ghost' });

  assert.equal(res.status, 200); // still acked — no Razorpay retry loop
  const { err } = await processed;
  assert.ok(err, 'must surface an error, not return quietly');
  assert.match(err.message, /NOT removed/);
  assert.ok(!ctx.shopify.calls.some((c) => c.op === 'removeTags'));
});

test('the grant records the subscription id and email that make a revoke reversible', async (t) => {
  const ctx = await startTestServer();
  t.after(ctx.close);

  const charged = chargedPayload({ email: 'linked@example.com', subscriptionId: 'sub_linked' });
  const processed = ctx.nextProcessed();
  await post(ctx.url, charged, { 'x-razorpay-signature': sign(charged), 'x-razorpay-event-id': 'evt_linked' });
  await processed;

  const grant = ctx.store.findLastGrant('sub_linked');
  assert.equal(grant.email, 'linked@example.com');
  assert.equal(grant.tag, 'membership-gold');
  assert.equal(grant.shopifyCustomerId, ctx.shopify.gidForEmail('linked@example.com'));
  assert.equal(ctx.store.findLastGrant('sub_unknown'), null);
});

test('every cancellation leaves a trace in the log, start to finish', async (t) => {
  const ctx = await startTestServer({ razorpayEmail: 'traced@example.com' });
  t.after(ctx.close);

  const charged = chargedPayload({ email: 'traced@example.com' });
  let processed = ctx.nextProcessed();
  await post(ctx.url, charged, { 'x-razorpay-signature': sign(charged), 'x-razorpay-event-id': 'evt_pre_trace' });
  await processed;

  const cancelled = cancelledPayload();
  processed = ctx.nextProcessed();
  await post(ctx.url, cancelled, { 'x-razorpay-signature': sign(cancelled), 'x-razorpay-event-id': 'evt_trace' });
  await processed;

  const received = ctx.logged.find((l) => l.msg === 'webhook received' && l.eventId === 'evt_trace');
  assert.equal(received.eventType, 'subscription.cancelled');
  assert.equal(received.subscriptionId, 'sub_test123');
  assert.ok(ctx.logged.some((l) => l.msg === 'revoke: start' && l.eventId === 'evt_trace'));
  assert.ok(ctx.logged.some((l) => l.msg === 'plan tag revoked' && l.identifiedVia === 'razorpay_email'));
});

test('cancellation removes every plan tag but leaves non-membership tags alone', async (t) => {
  const ctx = await startTestServer({ razorpayEmail: 'mixed@example.com' });
  t.after(ctx.close);

  // A long-standing customer: two membership tags plus tags we must not touch.
  const gid = ctx.shopify.seed('mixed@example.com', [
    'membership-gold',
    'membership-silver',
    'wholesale',
    'newsletter',
  ]);

  const cancelled = cancelledPayload();
  const processed = ctx.nextProcessed();
  await post(ctx.url, cancelled, { 'x-razorpay-signature': sign(cancelled), 'x-razorpay-event-id': 'evt_mixed' });
  const { err } = await processed;

  assert.equal(err, null);
  assert.deepEqual(ctx.shopify.tagsOf(gid).sort(), ['newsletter', 'wholesale']);
});

test('cancellation also clears a plan tag that is no longer in the catalog', async (t) => {
  const ctx = await startTestServer({ razorpayEmail: 'legacy@example.com' });
  t.after(ctx.close);

  // plan_tag from a retired tier: not in plans.json, but this subscription
  // granted it, so it has to come off too.
  const gid = ctx.shopify.seed('legacy@example.com', ['membership-bronze', 'wholesale']);

  const cancelled = cancelledPayload({ planKey: 'bronze', planTag: 'membership-bronze' });
  const processed = ctx.nextProcessed();
  await post(ctx.url, cancelled, { 'x-razorpay-signature': sign(cancelled), 'x-razorpay-event-id': 'evt_legacy' });
  const { err } = await processed;

  assert.equal(err, null);
  assert.deepEqual(ctx.shopify.tagsOf(gid), ['wholesale']);
});

test('a tier switch swaps the plan tag rather than stacking', async (t) => {
  const ctx = await startTestServer();
  t.after(ctx.close);

  const gid = ctx.shopify.seed('switcher@example.com', ['membership-silver', 'newsletter']);

  const upgrade = chargedPayload({ email: 'switcher@example.com', planKey: 'gold', planTag: 'membership-gold' });
  const processed = ctx.nextProcessed();
  await post(ctx.url, upgrade, { 'x-razorpay-signature': sign(upgrade), 'x-razorpay-event-id': 'evt_upgrade' });
  const { err } = await processed;

  assert.equal(err, null);
  assert.deepEqual(ctx.shopify.tagsOf(gid).sort(), ['membership-gold', 'newsletter']);
  // The new tag is added before the old one is cleared, so a failure mid-way
  // can never leave the member with no membership at all.
  const ops = ctx.shopify.calls.filter((c) => c.op === 'addTag' || c.op === 'removeTags');
  assert.equal(ops[0].op, 'addTag');
  assert.ok(!ops.some((c) => c.op === 'removeTags' && c.tags.includes('membership-gold')));
});

test('pending does not revoke (grace window)', async (t) => {
  const ctx = await startTestServer();
  t.after(ctx.close);

  const charged = chargedPayload({ email: 'p@example.com' });
  let processed = ctx.nextProcessed();
  await post(ctx.url, charged, { 'x-razorpay-signature': sign(charged), 'x-razorpay-event-id': 'evt_pre_pending' });
  await processed;

  const pending = JSON.stringify({
    entity: 'event',
    event: 'subscription.pending',
    payload: { subscription: { entity: { id: 'sub_test123', customer_id: 'cust_test1', notes: { plan: 'gold', plan_tag: 'membership-gold' } } } },
  });
  processed = ctx.nextProcessed();
  await post(ctx.url, pending, { 'x-razorpay-signature': sign(pending), 'x-razorpay-event-id': 'evt_pending' });
  await processed;

  assert.deepEqual(ctx.shopify.tagsOf(ctx.shopify.gidForEmail('p@example.com')), ['membership-gold']);
  // The charge clears superseded tiers, so removeTags does get called — what
  // must never happen is the ACTIVE tag being stripped during the grace window.
  assert.ok(!ctx.shopify.calls.some((c) => c.op === 'removeTags' && c.tags.includes('membership-gold')));
});

test('charge with no plan_tag in notes fails loudly, returns 200, no Shopify calls', async (t) => {
  const ctx = await startTestServer();
  t.after(ctx.close);

  const body = chargedPayload({ includeTag: false });
  const processed = ctx.nextProcessed();
  const res = await post(ctx.url, body, { 'x-razorpay-signature': sign(body), 'x-razorpay-event-id': 'evt_notag' });

  assert.equal(res.status, 200);
  const { err } = await processed;
  assert.ok(err && /plan_tag/.test(err.message));
  assert.equal(ctx.shopify.calls.length, 0);
});

test('charge with no resolvable email fails loudly (needs attention)', async (t) => {
  const ctx = await startTestServer({ razorpayEmail: null }); // customer fetch yields nothing
  t.after(ctx.close);

  const body = chargedPayload({ includeEmail: false }); // and no payment email
  const processed = ctx.nextProcessed();
  const res = await post(ctx.url, body, { 'x-razorpay-signature': sign(body), 'x-razorpay-event-id': 'evt_noemail' });

  assert.equal(res.status, 200);
  const { err } = await processed;
  assert.ok(err && /email/.test(err.message));
  assert.ok(!ctx.shopify.calls.some((c) => c.op === 'addTag'));
});

test('unhandled event type still gets a 200 (no retry loop)', async (t) => {
  const ctx = await startTestServer();
  t.after(ctx.close);

  const body = JSON.stringify({ entity: 'event', event: 'payment.captured', payload: {} });
  const processed = ctx.nextProcessed();
  const res = await post(ctx.url, body, { 'x-razorpay-signature': sign(body), 'x-razorpay-event-id': 'evt_other' });

  assert.equal(res.status, 200);
  const { err } = await processed;
  assert.equal(err, null);
  assert.equal(ctx.shopify.calls.length, 0);
});
