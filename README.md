# Renmoda Membership Service

Recurring membership engine for Renmoda: members pay a monthly fee via
**Razorpay Subscriptions** (UPI Autopay / card mandate) and receive **Shopify
store credit** they spend renting garments through normal Shopify checkout.

Shopify's native subscription APIs cannot bill through Razorpay (Razorpay is
excluded as a recurring gateway and Shopify Payments doesn't exist in India),
so every Shopify subscription app is a dead end. The recurring engine runs on
Razorpay, outside Shopify checkout, and this service syncs state into Shopify
via webhooks.

## How it works

```
Member ── POST /join ──> this service ──> Razorpay subscription (short_url)
Member completes UPI Autopay / card mandate on Razorpay's hosted page
Razorpay ── webhooks ──> this service ──> Shopify Admin GraphQL
```

| Razorpay event            | Action                                                        |
| ------------------------- | ------------------------------------------------------------- |
| `subscription.activated`  | Add `active_member` tag, set store credit to ₹4000            |
| `subscription.charged`    | Ensure tag, **reset** credit to ₹4000 (debit to 0, credit)    |
| `subscription.pending`    | Log only — grace window while Razorpay retries the charge     |
| `subscription.halted`     | Remove tag, zero credit (payment retries exhausted)           |
| `subscription.cancelled`  | Remove tag, zero credit (member cancelled autopay)            |
| `subscription.completed`  | Remove tag, zero credit (term finished)                       |
| anything else             | Log and 200                                                   |

Key design points (don't "simplify" these away):

- **Reset, not top-up.** Monthly charge wipes leftover credit and grants a
  fresh ₹4000. Members can't bank months and pull 8–12 items at once.
- **Reset fires on `subscription.charged`, never a cron.** Credit stays in
  lockstep with money actually collected; a failed/retried charge naturally
  delays the fresh credit.
- **No customer-mapping table.** The Shopify customer GID is written into the
  Razorpay subscription's `notes` at creation and echoed back on every
  webhook.
- **SQLite dedupes webhook deliveries.** Razorpay redelivers on timeout; a
  duplicate `subscription.charged` without dedupe would double-credit.
  `credit_log` is the audit trail for "why does this member have this balance?"
- **Whether leftover credit survives membership end** is the
  `REVOKE_CREDIT_ON_END` flag (default `true`) — an unfinalized business
  decision, deliberately config not code.

## Setup

### 1. Install

```bash
npm install
cp .env.example .env   # then fill it in
```

Node 20+ required (uses built-in `fetch`).

### 2. Shopify app + auth

Shopify removed static, admin-generated Admin API tokens (`shpat_…`) for newly
created apps, so there are two paths depending on what your store allows:

**Option A — legacy in-admin custom app (if your store still offers it).**
Admin → Settings → Apps and sales channels → Develop apps → Create an app.
Copy the Admin API access token (`shpat_…`) into `SHOPIFY_ADMIN_TOKEN` and
leave the client vars blank.

**Option B — Dev Dashboard app (current default).** Create the app in the
Shopify Dev/Partner Dashboard, install it on your store, and copy its **client
ID** and **client secret** into `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`
(leave `SHOPIFY_ADMIN_TOKEN` blank). How the service turns those into an Admin
token depends on your store type:

- **Development store** → the **client credentials grant**
  (`grant_type=client_credentials`). Only works when the app and store are in
  the same org. Gives a 24h token the service caches and auto-refreshes,
  including a one-time refresh-and-retry on a `401`.
- **Production / paid store** → client credentials is **not permitted**
  (`shop_not_permitted`). Use the one-time **OAuth install** below to get a
  permanent offline token instead.

#### Production store: one-time OAuth install

1. In the Dev Dashboard, add your callback URL to the app's **Allowed
   redirection URL(s)**:
   - local: `http://localhost:3000/oauth/callback`
   - VPS: `https://<your-domain>/oauth/callback` (also set `SHOPIFY_REDIRECT_URI`
     to it, since the proxy hides the public host)
2. Start the service (`npm start`).
3. As the **store owner**, open `…/oauth/install` in a browser. Approve the app.
4. The service exchanges the code for a non-expiring offline token and stores it
   in the SQLite DB (`shopify_tokens`). It's used automatically from then on —
   nothing to paste into `.env`.
5. Confirm with `npm run verify:shopify` (should print `source: offline` and
   pass). Re-running the install re-issues the token; delete the DB row to
   force a fresh install.

> Either way, the token's scopes are whatever the app is configured with **in
> the Dashboard** (Versions tab) — the grant doesn't request them. A token that
> authenticates but gets "access denied" on a mutation means a scope is missing
> there. `read_customers`/`write_customers` are protected customer data and may
> need approval in the app's customer-data settings.

Required scopes (either option):

- `read_customers`, `write_customers` (tags)
- `read_store_credit_accounts`
- `read_store_credit_account_transactions`, `write_store_credit_account_transactions`

The service verifies auth at boot: look for `"msg":"shopify auth ready"` with
`source` (`static` / `offline` / `client_credentials`) in the logs, or a loud
`needs_attention` error if auth isn't set up yet. Run `npm run verify:shopify`
any time to check auth **and** the `read_customers` scope in one shot.

Also required for members to actually *spend* credit:

- Settings → Customer accounts → use **new customer accounts** (store credit
  at checkout requires them).
- Settings → Payments → make sure **store credit** is enabled as a payment
  method.

### 3. Razorpay

1. Create a monthly **Plan** (Dashboard → Subscriptions → Plans) with the
   membership fee. Put its id in `RAZORPAY_PLAN_ID`.
2. Register the webhook: Dashboard → Account & Settings → Webhooks → Add:
   - URL: `https://<your-domain>/webhooks/razorpay`
   - Secret: a long random string → `RAZORPAY_WEBHOOK_SECRET`
     (this is **not** your API key secret)
   - Active events — subscribe to exactly these:
     - `subscription.activated`
     - `subscription.charged`
     - `subscription.pending`
     - `subscription.halted`
     - `subscription.cancelled`
     - `subscription.completed`

### 4. Run

```bash
npm start        # loads .env; equivalent to: node --env-file-if-exists=.env src/server.js
npm test         # signed-webhook end-to-end tests, Shopify mocked
```

## API

### `POST /join`

```json
{ "shopifyCustomerId": "7412345678901", "email": "member@example.com" }
```

`shopifyCustomerId` may be numeric or a full `gid://shopify/Customer/…`. If
only `email` is given, the customer is looked up in Shopify. Returns:

```json
{ "subscriptionId": "sub_…", "shortUrl": "https://rzp.io/i/…" }
```

Send the member to `shortUrl` to authorize autopay.

### `GET /join/redirect?customerId=…`

Same, but 302s straight to the Razorpay page — so the storefront button can be
a plain link (Liquid: `{{ customer.id }}`), no JS. On failure it 302s to
`JOIN_FAILURE_URL`.

> The join flow **must** go through this backend: each member needs their own
> subscription with their customer id in `notes`, otherwise the webhook can't
> tell whose wallet to credit. Never hand out one shared payment link.

### `POST /webhooks/razorpay`

Razorpay only. Signature-verified (HMAC-SHA256 over the raw bytes), deduped by
`x-razorpay-event-id`, acked with 200 before the Shopify work runs.

### `GET /oauth/install` and `GET /oauth/callback`

One-time OAuth install for a production store (see "Production store" above).
`/oauth/install` 302s the store owner to Shopify's consent screen;
`/oauth/callback` verifies the HMAC + state, exchanges the code for an offline
Admin token, and persists it. Not part of the runtime money path — only used
during setup / re-authorization.

### `GET /healthz`

Liveness probe for the proxy / systemd.

## Operations

### Logs

One JSON line per event on stdout/stderr. The line to alert on:

```
"msg":"EVENT PROCESSING FAILED AFTER ACK — needs manual attention","needs_attention":true
```

Razorpay will **not** redeliver an event we already 200'd, so these need a
human. Reconciliation query for a member's balance history:

```bash
sqlite3 data/membership.db \
  "SELECT created_at, event_type, action, amount, balance_after, note
   FROM credit_log WHERE shopify_customer_id LIKE '%<numeric id>' ORDER BY id;"
```

A `processed_events` row with **no** matching `credit_log` rows for a
`subscription.charged` event means processing died mid-flight (crash/API
failure) — re-apply the credit by hand in Shopify admin.

### VPS deploy (Hetzner + systemd + Caddy)

`/etc/systemd/system/renmoda-membership.service`:

```ini
[Unit]
Description=Renmoda membership service (Razorpay -> Shopify store credit)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=renmoda
WorkingDirectory=/opt/renmoda-membership
EnvironmentFile=/opt/renmoda-membership/.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
# Give in-flight Shopify credit work time to drain on stop/deploy.
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now renmoda-membership
journalctl -u renmoda-membership -f
```

`Caddyfile` (automatic HTTPS — Razorpay requires an https webhook URL):

```
membership.renmoda.in {
    reverse_proxy 127.0.0.1:3000
}
```

nginx equivalent, if preferred:

```nginx
server {
    server_name membership.renmoda.in;
    listen 443 ssl;
    # ssl_certificate ...; ssl_certificate_key ...;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Back up `data/membership.db` (it's WAL-mode SQLite; `sqlite3 … ".backup"` or
copy all three `membership.db*` files while stopped).

## Gotchas already handled — don't reintroduce them

- **Raw body for signatures.** The HMAC is over the exact bytes Razorpay sent.
  `express.json({ verify })` captures `req.rawBody`; never verify against a
  re-serialized body.
- **Atomic dedupe.** `INSERT OR IGNORE` + `changes > 0` claims an event in one
  statement. Check-then-insert races with concurrent redeliveries.
- **Always 200 unknown events.** Razorpay retries non-2xx forever.
- **Ack before slow work.** The 200 goes out before Shopify calls; post-ack
  failures are logged with `needs_attention: true`.
- **`pending` never revokes.** It's the retry grace window; only `halted`
  means retries are exhausted.
- **GIDs everywhere; `userErrors` checked on every mutation.** Shopify returns
  HTTP 200 with the real error nested in the payload.
