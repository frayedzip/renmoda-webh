// Shopify Admin GraphQL client via plain fetch. Two invariants live here:
//   1. Customer IDs are always normalized to GIDs before hitting the API.
//   2. Every mutation's userErrors are checked — Shopify returns HTTP 200
//      with errors nested in the payload, so a mutation can "succeed" at the
//      HTTP layer while silently doing nothing.

import { createShopifyTokenProvider } from './shopify-token.js';

export function normalizeCustomerGid(id) {
  const s = String(id ?? '').trim();
  if (s.startsWith('gid://shopify/Customer/')) return s;
  if (/^\d+$/.test(s)) return `gid://shopify/Customer/${s}`;
  throw new Error(`Invalid Shopify customer id: "${id}" (expected a numeric id or gid://shopify/Customer/...)`);
}

const CREDIT_MUTATION = `
  mutation StoreCreditCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
    storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
      storeCreditAccountTransaction {
        account { id balance { amount currencyCode } }
      }
      userErrors { field message }
    }
  }
`;

const DEBIT_MUTATION = `
  mutation StoreCreditDebit($id: ID!, $debitInput: StoreCreditAccountDebitInput!) {
    storeCreditAccountDebit(id: $id, debitInput: $debitInput) {
      storeCreditAccountTransaction {
        account { id balance { amount currencyCode } }
      }
      userErrors { field message }
    }
  }
`;

const STORE_CREDIT_QUERY = `
  query CustomerStoreCredit($id: ID!) {
    customer(id: $id) {
      id
      storeCreditAccounts(first: 10) {
        nodes { id balance { amount currencyCode } }
      }
    }
  }
`;

const TAGS_ADD_MUTATION = `
  mutation AddTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

const TAGS_REMOVE_MUTATION = `
  mutation RemoveTags($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

const CUSTOMER_BY_EMAIL_QUERY = `
  query FindCustomerByEmail($query: String!) {
    customers(first: 1, query: $query) {
      nodes { id email }
    }
  }
`;

export function createShopifyService(config, deps = {}) {
  const endpoint = `https://${config.shopify.shop}/admin/api/${config.shopify.apiVersion}/graphql.json`;
  // Injectable for tests; otherwise built from config (static token or client
  // credentials, decided in shopify-token.js).
  const tokenProvider =
    deps.tokenProvider ?? createShopifyTokenProvider({ config, store: deps.store, log: deps.log });

  async function graphql(query, variables, isRetry = false) {
    const token = await tokenProvider.getToken();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    });

    // A client-credentials token lives only 24h and can be rotated early. If it
    // lapsed, Shopify answers 401 — refresh once and retry rather than failing a
    // money-path mutation. Only client credentials can self-heal this way; a 401
    // on a static/offline token means it was revoked (app uninstalled), which a
    // retry can't fix, so surface it immediately. Retry is capped at one attempt.
    if (response.status === 401 && !isRetry && tokenProvider.activeSource?.() === 'client_credentials') {
      await tokenProvider.getToken({ force: true });
      return graphql(query, variables, true);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Shopify HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    const json = await response.json();
    if (json.errors?.length) {
      throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors).slice(0, 500)}`);
    }
    return json.data;
  }

  function assertNoUserErrors(operation, userErrors) {
    if (userErrors?.length) {
      throw new Error(`Shopify ${operation} userErrors: ${JSON.stringify(userErrors)}`);
    }
  }

  return {
    normalizeCustomerGid,
    tokenSource: () => tokenProvider.activeSource?.() ?? 'unknown',

    // Mint/validate the Admin token now so bad credentials surface at boot in
    // the logs instead of at the first webhook (when real money is moving).
    async warmUpToken() {
      await tokenProvider.getToken();
    },

    // Returns the customer's store credit account in the membership currency,
    // or null if they don't have one yet (first credit creates it).
    async getStoreCreditAccount(customerGid) {
      const data = await graphql(STORE_CREDIT_QUERY, { id: customerGid });
      if (!data.customer) {
        throw new Error(`Shopify customer not found: ${customerGid}`);
      }
      const accounts = data.customer.storeCreditAccounts?.nodes ?? [];
      return accounts.find((a) => a.balance.currencyCode === config.membership.currency) ?? null;
    },

    // `id` may be the customer GID — Shopify creates/uses the store credit
    // account for that owner+currency automatically.
    async creditStoreCredit(customerGid, amount) {
      const data = await graphql(CREDIT_MUTATION, {
        id: customerGid,
        creditInput: {
          creditAmount: { amount, currencyCode: config.membership.currency },
        },
      });
      const payload = data.storeCreditAccountCredit;
      assertNoUserErrors('storeCreditAccountCredit', payload?.userErrors);
      const account = payload?.storeCreditAccountTransaction?.account;
      if (!account) {
        throw new Error(`Shopify storeCreditAccountCredit returned no transaction for ${customerGid}`);
      }
      return { accountId: account.id, balance: account.balance };
    },

    // Debit requires the store credit ACCOUNT gid (read it first via
    // getStoreCreditAccount) — debiting a non-existent account is an error.
    async debitStoreCredit(accountGid, amount) {
      const data = await graphql(DEBIT_MUTATION, {
        id: accountGid,
        debitInput: {
          debitAmount: { amount, currencyCode: config.membership.currency },
        },
      });
      const payload = data.storeCreditAccountDebit;
      assertNoUserErrors('storeCreditAccountDebit', payload?.userErrors);
      const account = payload?.storeCreditAccountTransaction?.account;
      if (!account) {
        throw new Error(`Shopify storeCreditAccountDebit returned no transaction for ${accountGid}`);
      }
      return { accountId: account.id, balance: account.balance };
    },

    async addTag(customerGid, tag) {
      const data = await graphql(TAGS_ADD_MUTATION, { id: customerGid, tags: [tag] });
      assertNoUserErrors('tagsAdd', data.tagsAdd?.userErrors);
    },

    async removeTag(customerGid, tag) {
      const data = await graphql(TAGS_REMOVE_MUTATION, { id: customerGid, tags: [tag] });
      assertNoUserErrors('tagsRemove', data.tagsRemove?.userErrors);
    },

    async findCustomerByEmail(email) {
      const escaped = String(email).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const data = await graphql(CUSTOMER_BY_EMAIL_QUERY, { query: `email:"${escaped}"` });
      return data.customers?.nodes?.[0]?.id ?? null;
    },
  };
}
