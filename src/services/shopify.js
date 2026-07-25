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

const CUSTOMER_CREATE_MUTATION = `
  mutation CreateCustomer($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id email }
      userErrors { field message }
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

  // Sending an account invite has no GraphQL mutation, so this uses the REST
  // Admin API with the same token. numericId is the tail of the customer GID.
  async function restPost(pathTail) {
    const token = await tokenProvider.getToken();
    const url = `https://${config.shopify.shop}/admin/api/${config.shopify.apiVersion}/${pathTail}`;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: '{}',
    });
  }

  return {
    normalizeCustomerGid,
    tokenSource: () => tokenProvider.activeSource?.() ?? 'unknown',

    // Mint/validate the Admin token now so bad credentials surface at boot in
    // the logs instead of at the first webhook (when real money is moving).
    async warmUpToken() {
      await tokenProvider.getToken();
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

    async createCustomer(email) {
      const data = await graphql(CUSTOMER_CREATE_MUTATION, { input: { email } });
      assertNoUserErrors('customerCreate', data.customerCreate?.userErrors);
      const gid = data.customerCreate?.customer?.id;
      if (!gid) throw new Error(`Shopify customerCreate returned no customer for ${email}`);
      return gid;
    },

    // Best-effort account-invite email. On classic accounts this emails the
    // activation link; on new customer accounts there is no invite (members log
    // in with an emailed code), so a 4xx here is expected and non-fatal — we
    // never fail the membership grant over it.
    async sendAccountInvite(customerGid) {
      const numericId = String(customerGid).split('/').pop();
      const res = await restPost(`customers/${numericId}/send_invite.json`);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { sent: false, status: res.status, detail: text.slice(0, 200) };
      }
      return { sent: true };
    },

    // Resolve a Shopify customer from an email, creating one (and inviting them)
    // if none exists. Returns { gid, created }.
    async findOrCreateCustomer(email) {
      const existing = await this.findCustomerByEmail(email);
      if (existing) return { gid: existing, created: false };
      const gid = await this.createCustomer(email);
      const invite = await this.sendAccountInvite(gid);
      return { gid, created: true, invite };
    },
  };
}
