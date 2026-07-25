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
    async addTag(gid, tag) {
      calls.push({ op: 'addTag', customerGid: gid, tag });
      if (!tags.has(gid)) tags.set(gid, new Set());
      tags.get(gid).add(tag);
    },
    async removeTag(gid, tag) {
      calls.push({ op: 'removeTag', customerGid: gid, tag });
      tags.get(gid)?.delete(tag);
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
      subscription: { entity: { id: 'sub_test123', status: 'active', customer_id: customerId, notes } },
      payment: { entity: paymentEntity },
    },
  });
}

function cancelledPayload({ customerId = 'cust_test1', planKey = 'gold', planTag = 'membership-gold' } = {}) {
  // No payment entity — identity resolves via the Razorpay customer fetch.
  return JSON.stringify({
    entity: 'event',
    event: 'subscription.cancelled',
    payload: {
      subscription: {
        entity: { id: 'sub_test123', status: 'cancelled', customer_id: customerId, notes: { plan: planKey, plan_tag: planTag } },
      },
    },
  });
}

async function startTestServer({ razorpayEmail = 'member@example.com' } = {}) {
  const config = loadConfig(TEST_ENV);
  const log = { info() {}, warn() {}, error() {}, child() { return this; } };
  const store = createStore(':memory:');
  const shopify = createShopifyMock();
  const razorpay = createRazorpayService(config); // real verifyWebhookSignature
  razorpay.fetchCustomerEmail = async () => razorpayEmail; // stub the network call
  const membership = createMembershipService({ store, shopify, razorpay, log });

  const waiters = [];
  const onEventProcessed = (err, eventId) => {
    waiters.shift()?.({ err, eventId });
  };
  const nextProcessed = () => new Promise((resolve) => waiters.push(resolve));

  const app = createApp({ config, store, shopify, razorpay, membership, log, onEventProcessed });
  const server = app.listen(0);
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/webhooks/razorpay`;

  return { url, store, shopify, nextProcessed, close: () => server.close() };
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
  assert.ok(ctx.shopify.calls.some((c) => c.op === 'removeTag' && c.tag === 'membership-gold'));
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
  assert.ok(!ctx.shopify.calls.some((c) => c.op === 'removeTag'));
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
