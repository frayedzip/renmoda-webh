import { refreshOfflineToken } from './shopify-oauth.js';

// Shopify Admin API token provider. Resolves a usable Admin token from whichever
// of three sources is configured, in priority order:
//
//   1. static      — SHOPIFY_ADMIN_TOKEN in env (legacy in-admin custom app, or
//                    a token you pasted in yourself). Used as-is.
//   2. offline     — a token obtained via the OAuth authorization code flow and
//                    persisted in the store. This is the path for PRODUCTION
//                    stores (see routes/oauth.js + services/shopify-oauth.js).
//                    Normally non-expiring; refreshed here if Shopify made it
//                    expiring.
//   3. client_cred — minted from client id/secret via the client credentials
//                    grant. Only works on DEVELOPMENT stores in the app's org;
//                    a paid store returns shop_not_permitted.
//
// Precedence is dynamic (checked per call) so the moment an offline token lands
// after OAuth, it takes over from a failing client-credentials attempt with no
// restart.

const CLIENT_CRED_SKEW_MS = 5 * 60 * 1000; // refresh 5 min before the 24h expiry
const OFFLINE_SKEW_MS = 5 * 60 * 1000; // refresh an expiring offline token early

export function createShopifyTokenProvider({ config, store, log }) {
  const { adminToken, clientId, clientSecret, shop } = config.shopify;
  const hasClientCreds = Boolean(clientId && clientSecret);

  // ---- client credentials (dev-store) minting, cached ----------------------
  let ccCached = null; // { token, expiresAt }
  let ccInflight = null;

  async function fetchClientCredentialsToken() {
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // A paid store rejects client credentials outright — point the operator
      // at the flow that does work rather than leaving a cryptic error.
      if (/shop_not_permitted/.test(text)) {
        throw new Error(
          `Shopify client credentials not permitted on ${shop} (this is a production/paid store; ` +
            'client credentials only works on dev stores). Run the OAuth install flow at ' +
            `/oauth/install to get an offline token. Raw: HTTP ${res.status} ${text.slice(0, 200)}`
        );
      }
      throw new Error(`Shopify token grant failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    if (!json.access_token) {
      throw new Error(`Shopify token grant returned no access_token: ${JSON.stringify(json).slice(0, 200)}`);
    }
    const ttlMs = (Number(json.expires_in) || 86399) * 1000;
    ccCached = { token: json.access_token, expiresAt: Date.now() + ttlMs };
    log?.info?.('shopify admin token minted via client credentials', {
      scope: json.scope,
      expiresInSec: Math.round(ttlMs / 1000),
    });
    return ccCached.token;
  }

  function ccFresh() {
    return ccCached && ccCached.expiresAt - CLIENT_CRED_SKEW_MS > Date.now();
  }

  async function getClientCredentialsToken(force) {
    if (!force && ccFresh()) return ccCached.token;
    if (!ccInflight) {
      ccInflight = fetchClientCredentialsToken().finally(() => {
        ccInflight = null;
      });
    }
    return ccInflight;
  }

  // ---- offline (OAuth) token, read from the store, refreshed if expiring ----
  function storedOffline() {
    return store?.getShopifyToken?.(shop) ?? null;
  }

  async function getOfflineToken() {
    const rec = storedOffline();
    if (!rec) return null;

    // Non-expiring (the normal case): use directly.
    if (!rec.expiresAt) return rec.accessToken;

    const notYetExpired = new Date(rec.expiresAt).getTime() - OFFLINE_SKEW_MS > Date.now();
    if (notYetExpired) return rec.accessToken;

    // Expiring token past (or near) its expiry. Refresh if we can.
    if (!rec.refreshToken) {
      throw new Error(
        'Shopify offline token expired and no refresh_token is stored. Re-run the OAuth ' +
          'install flow at /oauth/install.'
      );
    }
    const refreshed = await refreshOfflineToken({ shop, clientId, clientSecret, refreshToken: rec.refreshToken });
    store.saveShopifyToken({ shop, ...refreshed });
    log?.info?.('shopify offline token refreshed', { scope: refreshed.scope });
    return refreshed.accessToken;
  }

  // Which source is currently active — for boot logging and to decide whether a
  // 401 is worth a refresh-and-retry (only client credentials can self-heal a
  // clock-expired token mid-request).
  function activeSource() {
    if (adminToken) return 'static';
    if (storedOffline()) return 'offline';
    if (hasClientCreds) return 'client_credentials';
    return 'none';
  }

  return {
    activeSource,
    async getToken({ force = false } = {}) {
      const source = activeSource();
      if (source === 'static') return adminToken;
      if (source === 'offline') return getOfflineToken();
      if (source === 'client_credentials') return getClientCredentialsToken(force);
      throw new Error(
        'No Shopify Admin token available. Set SHOPIFY_ADMIN_TOKEN, or complete the OAuth ' +
          'install flow at /oauth/install (production stores), or configure client credentials.'
      );
    },
  };
}
