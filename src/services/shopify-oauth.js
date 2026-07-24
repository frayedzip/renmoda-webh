import crypto from 'node:crypto';

// Shopify OAuth authorization code grant. This is the flow required for a
// PRODUCTION (paid) store — the client credentials grant only works on
// development stores in the app's own org (it returns shop_not_permitted on a
// paid store). The merchant approves once in the browser and we exchange the
// returned code for an OFFLINE Admin token.
//
// We request a NON-expiring offline token (we omit the `expiring` flag), so the
// normal response is just { access_token, scope } — a permanent token, the
// drop-in successor to the old shpat_ static token. If Shopify hands back an
// expiring token anyway (post-2026 forced-expiry regime), the response also
// carries refresh_token + expires_in and the token provider refreshes it.

// The Admin scopes this service needs. Kept here as the single source of truth
// for both the authorize URL and setup docs.
export const REQUIRED_SCOPES = [
  'read_customers',
  'write_customers',
  'read_store_credit_accounts',
  'read_store_credit_account_transactions',
  'write_store_credit_account_transactions',
];

export function buildAuthorizeUrl({ shop, clientId, scopes, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: scopes.join(','),
    redirect_uri: redirectUri,
    state,
    // grant_options[] omitted -> offline access token (what a backend needs).
  });
  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}

// Shopify signs the callback query params with the client secret. Verify before
// trusting anything in the callback. Message = params (minus hmac/signature)
// sorted by key, joined as key=value with &.
export function verifyCallbackHmac(query, clientSecret) {
  const { hmac, signature, ...rest } = query;
  if (!hmac || typeof hmac !== 'string') return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => {
      const value = Array.isArray(rest[key]) ? rest[key].join(',') : rest[key];
      return `${key}=${value}`;
    })
    .join('&');

  const digest = crypto.createHmac('sha256', clientSecret).update(message).digest('hex');
  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(hmac, 'utf8');
  // timingSafeEqual throws on unequal lengths; length isn't secret.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function normalizeTokenResponse(json) {
  if (!json.access_token) {
    throw new Error(`Shopify token response has no access_token: ${JSON.stringify(json).slice(0, 200)}`);
  }
  // expires_in present => Shopify issued an expiring token; compute an absolute
  // expiry so the provider can refresh it. Absent => non-expiring (the norm).
  const expiresAt = json.expires_in
    ? new Date(Date.now() + Number(json.expires_in) * 1000).toISOString()
    : null;
  return {
    accessToken: json.access_token,
    scope: json.scope ?? null,
    refreshToken: json.refresh_token ?? null,
    expiresAt,
  };
}

async function postTokenEndpoint(shop, body) {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Shopify token endpoint failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return normalizeTokenResponse(await res.json());
}

export function exchangeCodeForOfflineToken({ shop, clientId, clientSecret, code }) {
  return postTokenEndpoint(
    shop,
    new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code })
  );
}

// Only used if Shopify issued an expiring offline token (has a refresh_token).
export function refreshOfflineToken({ shop, clientId, clientSecret, refreshToken }) {
  return postTokenEndpoint(
    shop,
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })
  );
}
