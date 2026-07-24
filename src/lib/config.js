// Env loading + validation. Everything is validated at boot so a missing var
// crashes the process immediately instead of failing at the first webhook —
// which on this service means failing while real money is moving.

const REQUIRED = [
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'RAZORPAY_PLAN_ID',
  'SHOPIFY_SHOP',
  'JOIN_SUCCESS_URL',
  'JOIN_FAILURE_URL',
];

function toInt(value, name) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Config error: ${name} must be a positive integer, got "${value}"`);
  }
  return n;
}

function toBool(value, name) {
  const s = String(value).toLowerCase().trim();
  if (['true', '1', 'yes'].includes(s)) return true;
  if (['false', '0', 'no'].includes(s)) return false;
  throw new Error(`Config error: ${name} must be true/false, got "${value}"`);
}

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((key) => !env[key] || String(env[key]).trim() === '');
  if (missing.length > 0) {
    throw new Error(
      `Config error: missing required environment variables: ${missing.join(', ')}. ` +
        'See .env.example for what each one is.'
    );
  }

  if (String(env.RAZORPAY_WEBHOOK_SECRET) === String(env.RAZORPAY_KEY_SECRET)) {
    // The webhook secret comes from Dashboard -> Webhooks and is chosen when
    // registering the endpoint. Using key_secret here is a common mistake that
    // makes every signature check fail.
    throw new Error(
      'Config error: RAZORPAY_WEBHOOK_SECRET equals RAZORPAY_KEY_SECRET. ' +
        'The webhook secret is the one you set in Dashboard -> Webhooks, not your API key secret.'
    );
  }

  // Shopify auth comes in two shapes:
  //   - Legacy in-admin custom app  -> a static Admin token (shpat_...).
  //   - New Dev Dashboard app       -> client id + secret, which we exchange
  //     for a 24h Admin token via the client credentials grant at runtime
  //     (see services/shopify-token.js). Shopify removed static tokens for
  //     apps created after the Dev Dashboard migration.
  const rawAdminToken = (env.SHOPIFY_ADMIN_TOKEN ?? '').trim();
  // .env.example ships a "shpat_xxxx..." placeholder; treat that as unset so a
  // half-filled .env falls through to client credentials instead of sending a
  // bogus token on every Admin API call.
  const shopifyAdminToken = rawAdminToken && !rawAdminToken.includes('xxxx') ? rawAdminToken : null;
  const shopifyClientId = (env.SHOPIFY_CLIENT_ID ?? '').trim() || null;
  const shopifyClientSecret = (env.SHOPIFY_CLIENT_SECRET ?? '').trim() || null;

  if (!shopifyAdminToken && !(shopifyClientId && shopifyClientSecret)) {
    throw new Error(
      'Config error: Shopify auth not configured. Set SHOPIFY_ADMIN_TOKEN (legacy static ' +
        'token) OR both SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (Dev Dashboard app — the ' +
        'service mints an Admin token from them via the client credentials grant).'
    );
  }

  const allowance = toInt(env.MEMBERSHIP_ALLOWANCE ?? '4000', 'MEMBERSHIP_ALLOWANCE');

  return {
    port: toInt(env.PORT ?? '3000', 'PORT'),
    dbPath: env.DB_PATH ?? './data/membership.db',
    razorpay: {
      keyId: env.RAZORPAY_KEY_ID,
      keySecret: env.RAZORPAY_KEY_SECRET,
      webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
      planId: env.RAZORPAY_PLAN_ID,
      // 120 monthly cycles = 10 years; Razorpay requires a finite count, this
      // is the practical equivalent of "until cancelled".
      totalCount: toInt(env.RAZORPAY_TOTAL_COUNT ?? '120', 'RAZORPAY_TOTAL_COUNT'),
    },
    shopify: {
      shop: env.SHOPIFY_SHOP,
      // If a static token is validly set it wins (deliberate override);
      // otherwise the client credentials are used to mint tokens at runtime.
      adminToken: shopifyAdminToken,
      clientId: shopifyClientId,
      clientSecret: shopifyClientSecret,
      apiVersion: env.SHOPIFY_API_VERSION ?? '2025-01',
      // Explicit OAuth callback URL. Optional — derived from the request host if
      // unset. Set it behind a proxy where the public URL differs from the
      // internal host. Must match an Allowed redirection URL in the app config.
      oauthRedirectUri: (env.SHOPIFY_REDIRECT_URI ?? '').trim() || null,
    },
    membership: {
      allowance,
      currency: env.MEMBERSHIP_CURRENCY ?? 'INR',
      // Business policy the client hasn't finalized: does leftover credit
      // survive membership end? Flag, not code, so it can flip without a deploy.
      revokeCreditOnEnd: toBool(env.REVOKE_CREDIT_ON_END ?? 'true', 'REVOKE_CREDIT_ON_END'),
      activeTag: env.ACTIVE_MEMBER_TAG ?? 'active_member',
    },
    join: {
      successUrl: env.JOIN_SUCCESS_URL,
      failureUrl: env.JOIN_FAILURE_URL,
    },
  };
}
