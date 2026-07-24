// End-to-end webhook test with correctly-signed payloads. Shopify is mocked;
// the real signature verification, dedupe store, and membership logic run.
//
//   node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { loadConfig } from '../src/lib/config.js';
import { createStore } from '../src/db/store.js';
import { createRazorpayService } from '../src/services/razorpay.js';
import { createMembershipService } from '../src/services/membership.js';
import { createApp } from '../src/server.js';

const WEBHOOK_SECRET = 'test_webhook_secret';

const TEST_ENV = {
  PORT: '3000', // tests listen on an ephemeral port explicitly; this just satisfies config
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'rzp_test_secret',
  RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  RAZORPAY_PLAN_ID: 'plan_test',
  SHOPIFY_SHOP: 'renmoda-test.myshopify.com',
  SHOPIFY_ADMIN_TOKEN: 'shpat_test',
  JOIN_SUCCESS_URL: 'https://renmoda.example/thanks',
  JOIN_FAILURE_URL: 'https://renmoda.example/sorry',
  DB_PATH: ':memory:',
};

// In-memory stand-in for the Shopify service: same interface, tracks calls
// and simulates a single INR store credit account per customer.
function createShopifyMock() {
  const calls = [];
  const balances = new Map(); // customerGid -> number

  return {
    calls,
    balanceOf(gid) {
      return balances.get(gid) ?? 0;
    },
    async getStoreCreditAccount(customerGid) {
      calls.push({ op: 'getStoreCreditAccount', customerGid });
      const balance = balances.get(customerGid) ?? 0;
      if (balance <= 0) return null;
      return {
        id: `gid://shopify/StoreCreditAccount/${customerGid.split('/').pop()}`,
        balance: { amount: balance.toFixed(2), currencyCode: 'INR' },
      };
    },
    async creditStoreCredit(customerGid, amount) {
      calls.push({ op: 'credit', customerGid, amount });
      const next = (balances.get(customerGid) ?? 0) + Number.parseFloat(amount);
      balances.set(customerGid, next);
      return { accountId: 'gid://shopify/StoreCreditAccount/1', balance: { amount: next.toFixed(2), currencyCode: 'INR' } };
    },
    async debitStoreCredit(accountGid, amount) {
      calls.push({ op: 'debit', accountGid, amount });
      const customerGid = `gid://shopify/Customer/${accountGid.split('/').pop()}`;
      const next = (balances.get(customerGid) ?? 0) - Number.parseFloat(amount);
      balances.set(customerGid, next);
      return { accountId: accountGid, balance: { amount: next.toFixed(2), currencyCode: 'INR' } };
    },
    async addTag(customerGid, tag) {
      calls.push({ op: 'addTag', customerGid, tag });
    },
    async removeTag(customerGid, tag) {
      calls.push({ op: 'removeTag', customerGid, tag });
    },
    async findCustomerByEmail() {
      return null;
    },
  };
}

function sign(body) {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
}

function chargedPayload(customerId = '7412345678901') {
  return JSON.stringify({
    entity: 'event',
    event: 'subscription.charged',
    contains: ['subscription', 'payment'],
    payload: {
      subscription: {
        entity: {
          id: 'sub_test123',
          plan_id: 'plan_test',
          status: 'active',
          notes: { shopify_customer_id: customerId },
        },
      },
      payment: {
        entity: { id: 'pay_test123', amount: 400000, currency: 'INR' },
      },
    },
  });
}

async function startTestServer() {
  const config = loadConfig(TEST_ENV);
  const log = { info() {}, warn() {}, error() {}, child() { return this; } };
  const store = createStore(':memory:');
  const shopify = createShopifyMock();
  const razorpay = createRazorpayService(config);
  const membership = createMembershipService({ config, store, shopify, log });

  // Processing happens after the 200 is sent; this hook lets tests await it
  // deterministically instead of sleeping.
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
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

test('valid signature: 200, credits allowance, tags member, logs audit trail', async (t) => {
  const ctx = await startTestServer();
  t.after(ctx.close);

  const body = chargedPayload();
  const processed = ctx.nextProcessed();
  const res = await post(ctx.url, body, {
    'x-razorpay-signature': sign(body),
    'x-razorpay-event-id': 'evt_valid_1',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'accepted' });

  const { err } = await processed;
  assert.equal(err, null);

  const gid = 'gid://shopify/Customer/7412345678901';
  assert.equal(ctx.shopify.balanceOf(gid), 4000);
  assert.ok(ctx.shopify.calls.some((c) => c.op === 'credit' && c.amount === '4000.00'));
  assert.ok(ctx.shopify.calls.some((c) => c.op === 'addTag' && c.tag === 'active_member'));
  assert.equal(ctx.store.hasProcessed('evt_valid_1'), true);
});

test('tampered signature: rejected with 401, nothing processed', async (t) => {
  const ctx = await startTestServer();
  t.after(ctx.close);

  const body = chargedPayload();
  const goodSig = sign(body);
  // Flip one hex char — same length, so this also exercises the
  // timingSafeEqual path rather than the length guard.
  const tampered = (goodSig[0] === 'a' ? 'b' : 'a') + goodSig.slice(1);

  const res = await post(ctx.url, body, {
    'x-razorpay-signature': tampered,
    'x-razorpay-event-id': 'evt_tampered_1',
  });

  assert.equal(res.status, 401);
  assert.equal(ctx.shopify.calls.length, 0);
  assert.equal(ctx.store.hasProcessed('evt_tampered_1'), false);
});

test('missing signature: rejected with 401', async (t) => {
  const ctx = await startTestServer();
  t.after(ctx.close);

  const body = chargedPayload();
  const res = await post(ctx.url, body, { 'x-razorpay-event-id': 'evt_nosig_1' });

  assert.equal(res.status, 401);
  assert.equal(ctx.shopify.calls.length, 0);
});

test('duplicate event id: second delivery ignored, no double credit', async (t) => {
  const ctx = await startTestServer();
  t.after(ctx.close);

  const body = chargedPayload();
  const headers = {
    'x-razorpay-signature': sign(body),
    'x-razorpay-event-id': 'evt_dup_1',
  };

  const processed = ctx.nextProcessed();
  const first = await post(ctx.url, body, headers);
  assert.equal(first.status, 200);
  await processed;

  const callsAfterFirst = ctx.shopify.calls.length;

  const second = await post(ctx.url, body, headers);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { status: 'duplicate' });

  // Give any (incorrect) async processing a beat to show up before asserting.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ctx.shopify.calls.length, callsAfterFirst);
  assert.equal(ctx.shopify.balanceOf('gid://shopify/Customer/7412345678901'), 4000);
});

test('second month is a RESET, not a top-up', async (t) => {
  const ctx = await startTestServer();
  t.after(ctx.close);

  const body = chargedPayload();
  const sig = sign(body);

  let processed = ctx.nextProcessed();
  await post(ctx.url, body, { 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt_month_1' });
  await processed;

  processed = ctx.nextProcessed();
  await post(ctx.url, body, { 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt_month_2' });
  await processed;

  const gid = 'gid://shopify/Customer/7412345678901';
  // 4000, not 8000: month 2 debits the untouched 4000 then credits fresh 4000.
  assert.equal(ctx.shopify.balanceOf(gid), 4000);
  assert.ok(ctx.shopify.calls.some((c) => c.op === 'debit' && c.amount === '4000.00'));
});

test('cancellation removes tag and zeroes credit', async (t) => {
  const ctx = await startTestServer();
  t.after(ctx.close);

  const charged = chargedPayload();
  let processed = ctx.nextProcessed();
  await post(ctx.url, charged, {
    'x-razorpay-signature': sign(charged),
    'x-razorpay-event-id': 'evt_pre_cancel',
  });
  await processed;

  const cancelled = JSON.stringify({
    entity: 'event',
    event: 'subscription.cancelled',
    payload: {
      subscription: {
        entity: { id: 'sub_test123', status: 'cancelled', notes: { shopify_customer_id: '7412345678901' } },
      },
    },
  });

  processed = ctx.nextProcessed();
  const res = await post(ctx.url, cancelled, {
    'x-razorpay-signature': sign(cancelled),
    'x-razorpay-event-id': 'evt_cancel_1',
  });
  assert.equal(res.status, 200);
  const { err } = await processed;
  assert.equal(err, null);

  const gid = 'gid://shopify/Customer/7412345678901';
  assert.equal(ctx.shopify.balanceOf(gid), 0);
  assert.ok(ctx.shopify.calls.some((c) => c.op === 'removeTag' && c.tag === 'active_member'));
});

test('unhandled event type still gets a 200 (no retry loop)', async (t) => {
  const ctx = await startTestServer();
  t.after(ctx.close);

  const body = JSON.stringify({ entity: 'event', event: 'payment.captured', payload: {} });
  const processed = ctx.nextProcessed();
  const res = await post(ctx.url, body, {
    'x-razorpay-signature': sign(body),
    'x-razorpay-event-id': 'evt_other_1',
  });

  assert.equal(res.status, 200);
  const { err } = await processed;
  assert.equal(err, null);
  assert.equal(ctx.shopify.calls.length, 0);
});
