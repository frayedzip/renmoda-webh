// OAuth authorization code helpers: authorize URL, callback HMAC, code exchange.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildAuthorizeUrl,
  verifyCallbackHmac,
  exchangeCodeForOfflineToken,
} from '../src/services/shopify-oauth.js';

const SECRET = 'shpss_test_secret';

test('buildAuthorizeUrl includes client_id, scope, redirect_uri, state and offline mode', () => {
  const url = new URL(
    buildAuthorizeUrl({
      shop: 'renmoda.myshopify.com',
      clientId: 'cid',
      scopes: ['read_customers', 'write_customers'],
      redirectUri: 'https://m.renmoda.in/oauth/callback',
      state: 'nonce123',
    })
  );
  assert.equal(url.origin + url.pathname, 'https://renmoda.myshopify.com/admin/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.get('scope'), 'read_customers,write_customers');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://m.renmoda.in/oauth/callback');
  assert.equal(url.searchParams.get('state'), 'nonce123');
  // offline token => grant_options[] must NOT be present
  assert.equal(url.searchParams.get('grant_options[]'), null);
});

function signQuery(params, secret) {
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

test('verifyCallbackHmac accepts a correctly signed callback', () => {
  const params = { code: 'abc', shop: 'renmoda.myshopify.com', state: 'nonce123', timestamp: '1700000000' };
  const query = { ...params, hmac: signQuery(params, SECRET) };
  assert.equal(verifyCallbackHmac(query, SECRET), true);
});

test('verifyCallbackHmac rejects a tampered callback', () => {
  const params = { code: 'abc', shop: 'renmoda.myshopify.com', state: 'nonce123', timestamp: '1700000000' };
  const query = { ...params, hmac: signQuery(params, SECRET) };
  query.code = 'tampered';
  assert.equal(verifyCallbackHmac(query, SECRET), false);
});

test('verifyCallbackHmac rejects when hmac is missing', () => {
  assert.equal(verifyCallbackHmac({ code: 'abc', shop: 's' }, SECRET), false);
});

function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('exchangeCodeForOfflineToken returns a non-expiring token when Shopify omits expires_in', async () => {
  const f = stubFetch(async () => ({
    ok: true,
    status: 200,
    async json() { return { access_token: 'shpat_offline', scope: 'read_customers' }; },
    async text() { return ''; },
  }));
  try {
    const token = await exchangeCodeForOfflineToken({
      shop: 'renmoda.myshopify.com',
      clientId: 'cid',
      clientSecret: SECRET,
      code: 'the_code',
    });
    assert.equal(token.accessToken, 'shpat_offline');
    assert.equal(token.scope, 'read_customers');
    assert.equal(token.refreshToken, null);
    assert.equal(token.expiresAt, null); // non-expiring
    assert.match(f.calls[0].url, /\/admin\/oauth\/access_token$/);
    assert.match(f.calls[0].opts.body.toString(), /code=the_code/);
  } finally { f.restore(); }
});

test('exchangeCodeForOfflineToken computes expiresAt when Shopify issues an expiring token', async () => {
  const f = stubFetch(async () => ({
    ok: true,
    status: 200,
    async json() { return { access_token: 'shpat_exp', scope: 'read_customers', refresh_token: 'shprt_x', expires_in: 3600 }; },
    async text() { return ''; },
  }));
  try {
    const token = await exchangeCodeForOfflineToken({ shop: 's.myshopify.com', clientId: 'c', clientSecret: SECRET, code: 'x' });
    assert.equal(token.accessToken, 'shpat_exp');
    assert.equal(token.refreshToken, 'shprt_x');
    assert.ok(token.expiresAt, 'expiresAt should be set for an expiring token');
    assert.ok(new Date(token.expiresAt).getTime() > Date.now());
  } finally { f.restore(); }
});
