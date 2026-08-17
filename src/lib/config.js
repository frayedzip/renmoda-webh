// Env loading + validation. Everything is validated at boot so a missing var
// crashes the process immediately instead of failing at the first webhook —
// which on this service means failing while real money is moving.

import fs from 'node:fs';
import path from 'node:path';

const REQUIRED = [
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'SHOPIFY_SHOP',
  'JOIN_FAILURE_URL',
];
// JOIN_SUCCESS_URL is intentionally NOT required: there's no redirect back from
// Razorpay in this flow (the account-invite email brings new members into
// Shopify), so nothing reads it. Kept optional for a possible future redirect.

function toInt(value, name) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Config error: ${name} must be a positive integer, got "${value}"`);
  }
  return n;
}

// The plan catalog lives in a committed JSON file (not env) because it's a
// multi-field table per tier. Each membership button links to
// /join?plan=<key>; <key> maps to a Razorpay plan (its price = the monthly fee)
// and the customer tag applied while the membership is active. Validated hard
// at boot — a typo'd plan id would otherwise only surface when someone tries to
// subscribe.
function loadPlans(plansPath) {
  let raw;
  try {
    raw = fs.readFileSync(path.resolve(plansPath), 'utf8');
  } catch (err) {
    throw new Error(`Config error: cannot read plans file at "${plansPath}": ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Config error: "${plansPath}" is not valid JSON: ${err.message}`);
  }

  // Keys starting with _ (e.g. _comment) are documentation, not plans.
  const entries = Object.entries(parsed).filter(([key]) => !key.startsWith('_'));
  if (entries.length === 0) {
    throw new Error(
      `Config error: "${plansPath}" defines no plans. Add at least one entry: ` +
        '{ "<key>": { "razorpayPlanId": "plan_...", "tag": "membership-..." } }.'
    );
  }

  const plans = {};
  for (const [key, def] of entries) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) {
      throw new Error(`Config error: plan "${key}" must be an object with razorpayPlanId and tag.`);
    }
    const razorpayPlanId = String(def.razorpayPlanId ?? '').trim();
    const tag = String(def.tag ?? '').trim();
    if (!razorpayPlanId) throw new Error(`Config error: plan "${key}" is missing "razorpayPlanId".`);
    if (!tag) throw new Error(`Config error: plan "${key}" is missing "tag".`);
    plans[key] = { key, razorpayPlanId, tag };
  }
  return plans;
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
  //     for an Admin token at runtime (client credentials on a dev store, or an
  //     OAuth offline token on a production store; see services/shopify-token.js).
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
        'service mints an Admin token from them).'
    );
  }

  const plansPath = env.PLANS_PATH ?? './plans.json';

  // On by default: the post-ack failure log is the ONLY record that a cancelled
  // member kept their tag (Razorpay never redelivers an event we 200'd), so it
  // must survive whatever supervisor happens to be swallowing stdout.
  // LOG_FILE=off (or empty) turns it off for environments that capture stdout
  // properly and don't want a second copy.
  const rawLogFile = (env.LOG_FILE ?? './logs/membership.log').trim();
  const logFile = !rawLogFile || rawLogFile.toLowerCase() === 'off' ? null : rawLogFile;

  return {
    port: toInt(env.PORT ?? '3000', 'PORT'),
    dbPath: env.DB_PATH ?? './data/membership.db',
    plansPath,
    plans: loadPlans(plansPath),
    log: {
      file: logFile,
      maxBytes: toInt(env.LOG_MAX_BYTES ?? '10485760', 'LOG_MAX_BYTES'), // 10 MiB
      maxFiles: toInt(env.LOG_MAX_FILES ?? '5', 'LOG_MAX_FILES'),
    },
    razorpay: {
      keyId: env.RAZORPAY_KEY_ID,
      keySecret: env.RAZORPAY_KEY_SECRET,
      webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
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
    join: {
      successUrl: env.JOIN_SUCCESS_URL,
      failureUrl: env.JOIN_FAILURE_URL,
    },
  };
}
