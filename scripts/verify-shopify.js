// One-shot Shopify setup check. Run after configuring credentials/installing
// the app:  npm run verify:shopify
//
// It (1) mints/loads an Admin token and (2) makes a real Admin API call that
// requires the read_customers scope, so it catches both auth problems (bad
// credentials, app not installed, wrong org) and missing-scope problems before
// a live webhook does.

import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/log.js';
import { createShopifyService } from '../src/services/shopify.js';

const log = createLogger({ service: 'verify-shopify' });

function fail(msg, hint) {
  console.error(`\n❌ ${msg}`);
  if (hint) console.error(`\n   ${hint}`);
  process.exit(1);
}

const config = loadConfig();
const { createStore } = await import('../src/db/store.js');
const store = createStore(config.dbPath); // read any offline token from the OAuth flow

const shopify = createShopifyService(config, { log, store });
console.log(`shop:   ${config.shopify.shop}`);
console.log(`source: ${shopify.tokenSource()}\n`);

// 1. Auth: resolve the Admin token (static / offline / client credentials).
try {
  await shopify.warmUpToken();
  console.log('✅ Admin token OK');
} catch (err) {
  if (/shop_not_permitted|oauth\/install/.test(err.message)) {
    fail(
      'This is a production/paid store — the client credentials grant is not allowed here.',
      'Get an offline token via the OAuth install flow: start the server (npm start) and, as the ' +
        'store owner, open  https://<your-public-url>/oauth/install  once. It stores a permanent ' +
        'offline token; re-run this check afterwards. (Add that callback URL to the app\'s Allowed ' +
        'redirection URLs in the Dev Dashboard first.)'
    );
  }
  if (/app_not_installed/.test(err.message)) {
    fail(
      'Token grant rejected: app_not_installed.',
      'Install the app on this store: Dev Dashboard -> your app -> Home -> Install app -> Install.'
    );
  }
  if (/HTTP 40[13]/.test(err.message)) {
    fail(
      `Token grant rejected: ${err.message}`,
      'Check SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET match the app Settings in the Dev Dashboard.'
    );
  }
  fail(`Token grant failed: ${err.message}`);
}

// 2. Scope: a call that needs read_customers. Access-denied here means the app
//    is authenticated but the scope isn't granted (or protected-customer-data
//    access isn't approved yet).
try {
  await shopify.findCustomerByEmail('verify-probe@renmoda.invalid'); // expected: no match -> null
  console.log('✅ Admin API reachable and read_customers scope granted');
  console.log('\nAll Shopify checks passed.');
} catch (err) {
  if (/access denied|not approved|scope/i.test(err.message)) {
    fail(
      `Admin API call denied: ${err.message}`,
      'Add the required scopes on the app version (Dev Dashboard -> Versions), then re-install/' +
        'release. read_customers/write_customers are protected customer data and may need approval ' +
        'under the app\'s customer-data settings.'
    );
  }
  fail(`Admin API call failed: ${err.message}`);
}
