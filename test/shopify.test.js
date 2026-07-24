// Shopify Admin client: GID normalization + the money-path 401 refresh-retry.
// global fetch is stubbed; the token provider is injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShopifyService, normalizeCustomerGid } from '../src/services/shopify.js';

const config = {
  shopify: { shop: 's.myshopify.com', apiVersion: '2025-01', adminToken: null, clientId: 'c', clientSecret: 'x' },
  membership: { currency: 'INR' },
};

test('normalizeCustomerGid accepts numeric and gid forms, rejects junk', () => {
  assert.equal(normalizeCustomerGid('123'), 'gid://shopify/Customer/123');
  assert.equal(normalizeCustomerGid('gid://shopify/Customer/123'), 'gid://shopify/Customer/123');
  assert.throws(() => normalizeCustomerGid('not-an-id'));
});

test('graphql refreshes the token once and retries on 401', async () => {
  // Simulate a stale token that 401s, then a fresh one that succeeds.
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
    if (token === 'stale') {
      return { ok: false, status: 401, async json() { return {}; }, async text() { return 'unauthorized'; } };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { data: { customer: { id: 'gid://shopify/Customer/1', storeCreditAccounts: { nodes: [] } } } };
      },
    };
  };

  try {
    const shopify = createShopifyService(config, { tokenProvider });
    const account = await shopify.getStoreCreditAccount('gid://shopify/Customer/1');

    // Call ultimately succeeded (no INR account exists yet -> null).
    assert.equal(account, null);
    // First attempt used the stale token, retry used the refreshed one.
    assert.deepEqual(sentTokens, ['stale', 'fresh']);
    assert.equal(forced.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('graphql does NOT retry a 401 for an offline/static token (revoked, not refreshable)', async () => {
  // A 401 on an offline token means the app was uninstalled — retrying with the
  // same token is pointless, so it should fail on the first response.
  const tokenProvider = {
    activeSource: () => 'offline',
    async getToken() { return 'shpat_offline'; },
  };

  let attempts = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts += 1;
    return { ok: false, status: 401, async json() { return {}; }, async text() { return 'unauthorized'; } };
  };

  try {
    const shopify = createShopifyService(config, { tokenProvider });
    await assert.rejects(() => shopify.getStoreCreditAccount('gid://shopify/Customer/1'), /HTTP 401/);
    assert.equal(attempts, 1); // no retry
  } finally {
    globalThis.fetch = original;
  }
});

test('graphql does not loop: a persistent 401 fails after one retry', async () => {
  const tokenProvider = {
    activeSource: () => 'client_credentials',
    async getToken() { return 'always-stale'; },
  };

  let attempts = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts += 1;
    return { ok: false, status: 401, async json() { return {}; }, async text() { return 'unauthorized'; } };
  };

  try {
    const shopify = createShopifyService(config, { tokenProvider });
    await assert.rejects(() => shopify.getStoreCreditAccount('gid://shopify/Customer/1'), /HTTP 401/);
    assert.equal(attempts, 2); // original + exactly one retry
  } finally {
    globalThis.fetch = original;
  }
});
