// Token provider: static passthrough + client-credentials mint/cache/refresh.
// global fetch is stubbed; no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShopifyTokenProvider } from '../src/services/shopify-token.js';

const baseConfig = (over = {}) => ({
  shopify: {
    shop: 'renmoda-test.myshopify.com',
    adminToken: null,
    clientId: 'client_abc',
    clientSecret: 'secret_xyz',
    apiVersion: '2025-01',
    ...over,
  },
});

function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts, calls.length);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function grantResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

test('static admin token mode returns the token with no HTTP call', async () => {
  const f = stubFetch(() => { throw new Error('should not fetch in static mode'); });
  try {
    const tp = createShopifyTokenProvider({ config: baseConfig({ adminToken: 'shpat_static' }) });
    assert.equal(tp.activeSource(), 'static');
    assert.equal(await tp.getToken(), 'shpat_static');
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test('client credentials: mints, caches, and sends the right grant request', async () => {
  const f = stubFetch(async () =>
    grantResponse(200, { access_token: 'tok_1', scope: 'read_customers', expires_in: 86399 })
  );
  try {
    const tp = createShopifyTokenProvider({ config: baseConfig() });
    assert.equal(tp.activeSource(), 'client_credentials');

    const t1 = await tp.getToken();
    const t2 = await tp.getToken();
    assert.equal(t1, 'tok_1');
    assert.equal(t2, 'tok_1');
    assert.equal(f.calls.length, 1); // second call served from cache

    assert.match(f.calls[0].url, /^https:\/\/renmoda-test\.myshopify\.com\/admin\/oauth\/access_token$/);
    const body = f.calls[0].opts.body.toString();
    assert.match(body, /grant_type=client_credentials/);
    assert.match(body, /client_id=client_abc/);
    assert.match(body, /client_secret=secret_xyz/);
    assert.equal(f.calls[0].opts.headers['content-type'], 'application/x-www-form-urlencoded');
  } finally { f.restore(); }
});

test('force refresh mints a new token', async () => {
  let n = 0;
  const f = stubFetch(async () => grantResponse(200, { access_token: `tok_${++n}`, expires_in: 86399 }));
  try {
    const tp = createShopifyTokenProvider({ config: baseConfig() });
    assert.equal(await tp.getToken(), 'tok_1');
    assert.equal(await tp.getToken({ force: true }), 'tok_2');
    assert.equal(f.calls.length, 2);
  } finally { f.restore(); }
});

test('concurrent getToken calls collapse into a single grant request', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = stubFetch(async () => {
    await gate;
    return grantResponse(200, { access_token: 'tok_concurrent', expires_in: 86399 });
  });
  try {
    const tp = createShopifyTokenProvider({ config: baseConfig() });
    const p1 = tp.getToken();
    const p2 = tp.getToken();
    release();
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(a, 'tok_concurrent');
    assert.equal(b, 'tok_concurrent');
    assert.equal(f.calls.length, 1);
  } finally { f.restore(); }
});

test('grant failure surfaces the HTTP status loudly', async () => {
  const f = stubFetch(async () => grantResponse(401, { error: 'invalid_client' }));
  try {
    const tp = createShopifyTokenProvider({ config: baseConfig() });
    await assert.rejects(() => tp.getToken(), /HTTP 401/);
  } finally { f.restore(); }
});

test('a response without access_token is rejected, not cached as undefined', async () => {
  const f = stubFetch(async () => grantResponse(200, { scope: 'read_customers' }));
  try {
    const tp = createShopifyTokenProvider({ config: baseConfig() });
    await assert.rejects(() => tp.getToken(), /no access_token/);
  } finally { f.restore(); }
});

test('shop_not_permitted (paid store) surfaces a message pointing to /oauth/install', async () => {
  const f = stubFetch(async () =>
    grantResponse(400, { error: 'shop_not_permitted', error_description: 'Client credentials cannot be performed on this shop.' })
  );
  try {
    const tp = createShopifyTokenProvider({ config: baseConfig() });
    await assert.rejects(() => tp.getToken(), /\/oauth\/install/);
  } finally { f.restore(); }
});

// Minimal in-memory store honoring the getShopifyToken/saveShopifyToken shape.
function fakeStore(initial = null) {
  let rec = initial;
  return {
    getShopifyToken: () => rec,
    saveShopifyToken: (t) => { rec = { shop: 's', ...t }; },
    current: () => rec,
  };
}

test('offline stored token (non-expiring) is used directly and outranks client credentials', async () => {
  const f = stubFetch(() => { throw new Error('should not hit the network for a non-expiring offline token'); });
  try {
    const store = fakeStore({ shop: 's', accessToken: 'shpat_offline', scope: 'read_customers', refreshToken: null, expiresAt: null });
    const tp = createShopifyTokenProvider({ config: baseConfig(), store });
    assert.equal(tp.activeSource(), 'offline');
    assert.equal(await tp.getToken(), 'shpat_offline');
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test('expired offline token is refreshed via refresh_token and re-saved', async () => {
  const f = stubFetch(async () =>
    grantResponse(200, { access_token: 'shpat_new', scope: 'read_customers', refresh_token: 'shprt_new', expires_in: 3600 })
  );
  try {
    const store = fakeStore({
      shop: 's',
      accessToken: 'shpat_old',
      scope: 'read_customers',
      refreshToken: 'shprt_old',
      expiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
    });
    const tp = createShopifyTokenProvider({ config: baseConfig(), store });
    const token = await tp.getToken();
    assert.equal(token, 'shpat_new');
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0].opts.body.toString(), /grant_type=refresh_token/);
    // New token persisted for next time.
    assert.equal(store.current().accessToken, 'shpat_new');
    assert.equal(store.current().refreshToken, 'shprt_new');
  } finally { f.restore(); }
});
