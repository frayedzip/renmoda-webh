// Shopify Admin client: GID normalization + the 401 refresh-retry on a mutation.
// global fetch is stubbed; the token provider is injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShopifyService, normalizeCustomerGid } from '../src/services/shopify.js';

const config = {
  shopify: { shop: 's.myshopify.com', apiVersion: '2025-01', adminToken: null, clientId: 'c', clientSecret: 'x' },
};

const tagsAddOk = {
  ok: true,
  status: 200,
  async json() { return { data: { tagsAdd: { node: { id: 'gid://shopify/Customer/1' }, userErrors: [] } } }; },
};
const unauthorized = {
  ok: false,
  status: 401,
  async json() { return {}; },
  async text() { return 'unauthorized'; },
};

test('normalizeCustomerGid accepts numeric and gid forms, rejects junk', () => {
  assert.equal(normalizeCustomerGid('123'), 'gid://shopify/Customer/123');
  assert.equal(normalizeCustomerGid('gid://shopify/Customer/123'), 'gid://shopify/Customer/123');
  assert.throws(() => normalizeCustomerGid('not-an-id'));
});

test('a mutation refreshes the token once and retries on 401', async () => {
  let current = 'stale';
  const forced = [];
  const tokenProvider = {
    activeSource: () => 'client_credentials',
    async getToken({ force = false } = {}) {
      if (force) { current = 'fresh'; forced.push(true); }
      return current;
    },
  };

  const sentTokens = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const token = opts.headers['X-Shopify-Access-Token'];
    sentTokens.push(token);
    return token === 'stale' ? unauthorized : tagsAddOk;
  };

  try {
    const shopify = createShopifyService(config, { tokenProvider });
    await shopify.addTag('gid://shopify/Customer/1', 'membership-gold'); // resolves (no throw)
    assert.deepEqual(sentTokens, ['stale', 'fresh']); // retried with refreshed token
    assert.equal(forced.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('a mutation does NOT retry a 401 for an offline/static token (revoked, not refreshable)', async () => {
  const tokenProvider = {
    activeSource: () => 'offline',
    async getToken() { return 'shpat_offline'; },
  };

  let attempts = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { attempts += 1; return unauthorized; };

  try {
    const shopify = createShopifyService(config, { tokenProvider });
    await assert.rejects(() => shopify.addTag('gid://shopify/Customer/1', 'membership-gold'), /HTTP 401/);
    assert.equal(attempts, 1); // no retry
  } finally {
    globalThis.fetch = original;
  }
});

test('a mutation does not loop: a persistent 401 fails after one retry', async () => {
  const tokenProvider = {
    activeSource: () => 'client_credentials',
    async getToken() { return 'always-stale'; },
  };

  let attempts = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { attempts += 1; return unauthorized; };

  try {
    const shopify = createShopifyService(config, { tokenProvider });
    await assert.rejects(() => shopify.addTag('gid://shopify/Customer/1', 'membership-gold'), /HTTP 401/);
    assert.equal(attempts, 2); // original + exactly one retry
  } finally {
    globalThis.fetch = original;
  }
});

test('findOrCreateCustomer: creates + invites when the email is unknown', async () => {
  const tokenProvider = { activeSource: () => 'static', async getToken() { return 'shpat_x'; } };
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push(url);
    if (String(url).endsWith('/send_invite.json')) {
      return { ok: true, status: 200, async json() { return {}; }, async text() { return ''; } };
    }
    const body = JSON.parse(opts.body);
    if (/FindCustomerByEmail/.test(body.query)) {
      return { ok: true, status: 200, async json() { return { data: { customers: { nodes: [] } } }; } };
    }
    // customerCreate
    return {
      ok: true,
      status: 200,
      async json() {
        return { data: { customerCreate: { customer: { id: 'gid://shopify/Customer/555', email: 'new@x.com' }, userErrors: [] } } };
      },
    };
  };

  try {
    const shopify = createShopifyService(config, { tokenProvider });
    const result = await shopify.findOrCreateCustomer('new@x.com');
    assert.equal(result.created, true);
    assert.equal(result.gid, 'gid://shopify/Customer/555');
    assert.equal(result.invite.sent, true);
    // REST invite targeted the numeric id from the new GID.
    assert.ok(seen.some((u) => String(u).includes('/customers/555/send_invite.json')));
  } finally {
    globalThis.fetch = original;
  }
});

test('findOrCreateCustomer: returns existing (no create/invite) when the email is known', async () => {
  const tokenProvider = { activeSource: () => 'static', async getToken() { return 'shpat_x'; } };
  let createCalled = false;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).endsWith('/send_invite.json')) { createCalled = true; return { ok: true, status: 200, async json() { return {}; } }; }
    const body = JSON.parse(opts.body);
    if (/CreateCustomer/.test(body.query)) { createCalled = true; }
    return { ok: true, status: 200, async json() { return { data: { customers: { nodes: [{ id: 'gid://shopify/Customer/42', email: 'known@x.com' }] } } }; } };
  };
  try {
    const shopify = createShopifyService(config, { tokenProvider });
    const result = await shopify.findOrCreateCustomer('known@x.com');
    assert.equal(result.created, false);
    assert.equal(result.gid, 'gid://shopify/Customer/42');
    assert.equal(createCalled, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('userErrors in a mutation payload are surfaced as an error', async () => {
  const tokenProvider = { activeSource: () => 'static', async getToken() { return 'shpat_x'; } };
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { data: { tagsAdd: { node: null, userErrors: [{ field: ['id'], message: 'Customer does not exist' }] } } };
    },
  });
  try {
    const shopify = createShopifyService(config, { tokenProvider });
    await assert.rejects(() => shopify.addTag('gid://shopify/Customer/999', 'x'), /userErrors/);
  } finally {
    globalThis.fetch = original;
  }
});
