import crypto from 'node:crypto';
import { Router } from 'express';
import {
  REQUIRED_SCOPES,
  buildAuthorizeUrl,
  verifyCallbackHmac,
  exchangeCodeForOfflineToken,
} from '../services/shopify-oauth.js';

// One-time OAuth install flow to obtain an offline Admin token for a production
// store (client credentials doesn't work there). Visit GET /oauth/install once
// as the store owner; the token is exchanged and persisted, after which the
// token provider uses it automatically.

export function createOAuthRouter({ config, store, log }) {
  const router = Router();

  // State nonces live in memory: the flow completes in seconds within this
  // single process, and a nonce surviving a restart has no value.
  const pendingStates = new Map(); // state -> expiresAt (ms)

  function reapStates() {
    const now = Date.now();
    for (const [state, exp] of pendingStates) {
      if (exp < now) pendingStates.delete(state);
    }
  }

  function redirectUri(req) {
    // Explicit override wins (needed behind a proxy where host may differ);
    // otherwise derive from the request. Must exactly match one of the app's
    // Allowed redirection URLs in the Dev Dashboard.
    return config.shopify.oauthRedirectUri || `${req.protocol}://${req.get('host')}/oauth/callback`;
  }

  router.get('/install', (req, res) => {
    if (!config.shopify.clientId || !config.shopify.clientSecret) {
      return res.status(400).send('SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET not configured.');
    }
    reapStates();
    const state = crypto.randomBytes(16).toString('hex');
    pendingStates.set(state, Date.now() + 10 * 60 * 1000);

    const url = buildAuthorizeUrl({
      shop: config.shopify.shop,
      clientId: config.shopify.clientId,
      scopes: REQUIRED_SCOPES,
      redirectUri: redirectUri(req),
      state,
    });
    log.info('oauth install initiated', { shop: config.shopify.shop, redirectUri: redirectUri(req) });
    res.redirect(302, url);
  });

  router.get('/callback', async (req, res) => {
    try {
      const { shop, code, state } = req.query;

      // 1. state: must be one we issued and not expired (CSRF guard).
      const exp = pendingStates.get(state);
      pendingStates.delete(state);
      if (!exp || exp < Date.now()) throw new Error('invalid or expired state');

      // 2. hmac: proves the callback — including the `shop` value below — really
      //    came from Shopify. Verify BEFORE trusting `shop`, so the domain we
      //    match/report is Shopify-signed, not attacker-supplied.
      if (!verifyCallbackHmac(req.query, config.shopify.clientSecret)) {
        throw new Error('hmac verification failed');
      }

      // 3. shop: must be the canonical store we're configured for. A mismatch
      //    almost always means SHOPIFY_SHOP is set to a non-canonical alias —
      //    Shopify returns the store's real .myshopify.com domain here, so name
      //    it in the error to make the fix obvious.
      if (shop !== config.shopify.shop) {
        throw new Error(
          `unexpected shop: Shopify returned "${shop}" but SHOPIFY_SHOP is ` +
            `"${config.shopify.shop}". If "${shop}" is your store's real (canonical) ` +
            `.myshopify.com domain, set SHOPIFY_SHOP to it and retry /oauth/install.`
        );
      }
      if (!code) throw new Error('missing authorization code');

      // 4. exchange code -> offline token, persist it.
      const token = await exchangeCodeForOfflineToken({
        shop: config.shopify.shop,
        clientId: config.shopify.clientId,
        clientSecret: config.shopify.clientSecret,
        code,
      });
      store.saveShopifyToken({ shop: config.shopify.shop, ...token });
      log.info('oauth offline token stored', {
        shop: config.shopify.shop,
        scope: token.scope,
        expiring: Boolean(token.expiresAt),
      });

      res
        .status(200)
        .send('Renmoda membership app authorized. Offline Admin token stored — you can close this tab.');
    } catch (err) {
      log.error('oauth callback failed', { error: err.message });
      res.status(400).send(`OAuth failed: ${err.message}`);
    }
  });

  return router;
}
