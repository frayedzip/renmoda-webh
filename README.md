# Renmoda Membership Service

Recurring membership engine for Renmoda: members pay a monthly fee via
**Razorpay Subscriptions** (UPI Autopay / card mandate) and, while their
subscription is active, carry a **plan tag** on their Shopify customer record.
The tag identifies which tier they're on; the storefront uses it to gate
access / benefits.

Shopify's native subscription APIs cannot bill through Razorpay (Razorpay is
excluded as a recurring gateway and Shopify Payments doesn't exist in India),
so every Shopify subscription app is a dead end. The recurring engine runs on
Razorpay, outside Shopify checkout, and this service syncs state into Shopify
via webhooks.

## How it works

The visitor does **not** need a Shopify account first. They click a plan button
(carrying only the plan), enter their details on **Razorpay**, and their Shopify
identity is derived afterward from the email Razorpay collected.

```
Member clicks a plan button ──> GET /join/redirect?plan=<key>
  ──> this service creates a Razorpay subscription (notes = {plan, plan_tag})
      and 302s to subscription.short_url
Member enters email + completes UPI Autopay / card mandate on Razorpay
Razorpay ── webhooks ──> this service:
      resolve email ──> find-or-create Shopify customer (new → account invite)
      ──> add the plan tag
```

Each plan (`gold`, `silver`, …) maps in `plans.json` to a Razorpay plan id and a
customer tag. At `/join` the chosen plan's tag is stamped into the subscription
`notes`, so every webhook carries the tag to apply — no catalog lookup at webhook
time.

| Razorpay event            | Action                                                        |
| ------------------------- | ------------------------------------------------------------- |
| `subscription.charged`    | Find-or-create customer → add this plan's tag, clear other tiers |
| `subscription.activated`  | Best-effort add (no payment email yet; `charged` grants)      |
| `subscription.pending`    | Log only — grace window while Razorpay retries the charge     |
| `subscription.halted`     | Identify member → clear all plan tags (retries exhausted)     |
| `subscription.cancelled`  | Identify member → clear all plan tags (member cancelled)      |
| `subscription.completed`  | Identify member → clear all plan tags (term finished)         |
| anything else             | Log and 200                                                   |

Key design points (don't "simplify" these away):

- **Identity comes from Razorpay, not the button.** The button carries only the
  plan. The member's email is read from `payload.payment.entity.email` on
  `charged` (or, on events with no payment entity, by fetching the Razorpay
  customer via `payload.subscription.entity.customer_id`). From the email we
  find-or-create the Shopify customer; new ones get an **account-invite email**,
  which is how they enter Shopify — so no redirect back from Razorpay is needed.
- **The tag rides in the subscription `notes`, not a lookup.** Stamped at
  `/join`, echoed on every webhook, so the handler needs no catalog lookup and
  stays correct even if `plans.json` changes.
- **One plan tag at a time.** A charge adds the tag from `notes` and then clears
  every *other* catalog tag, so an upgrade swaps `membership-starter` for
  `membership-premium` instead of stacking both. The new tag goes on **before**
  the old ones come off, so a mid-way failure can never leave a paying member
  with no membership at all. Tagging stays idempotent — no reset/top-up/
  allowance and no cron. `subscription.pending` never removes anything; it's the
  grace window while Razorpay retries, and only `halted` means retries are
  exhausted.
- **Ending a membership clears every plan tag**, not just the one that
  subscription granted — plus the tag in its `notes`, so a retired tier that's
  no longer in `plans.json` still comes off. The tag list is exactly the
  `plans.json` catalog: no prefix matching, so anything else on the customer
  (`wholesale`, `newsletter`, a hand-applied comp tag) is never touched.
  Consequence to know about: a member holding **two** active subscriptions who
  cancels one loses the tag for both, and won't get it back until the surviving
  subscription's next charge. The design assumes one membership per customer.
- **SQLite dedupes webhook deliveries.** Razorpay redelivers on timeout;
  `membership_log` is the audit trail for "why does this member have this tag?"
- **Identity is asymmetric — this is the sharp edge.** A grant knows the member
  by the **payment** email (`payload.payment.entity.email`); a revoke has no
  payment entity and can only ask Razorpay for the **customer record's** email.
  Razorpay does not guarantee those match (the customer record can hold a
  different address, or none, e.g. UPI-only checkouts). So every grant writes
  `subscription_id -> shopify_customer_id` into `membership_log`, and a revoke
  that can't find anyone by email falls back to that link. Without it, a
  divergent email means the untag finds nobody and the tag stays on.
- **Fails loudly** (logged with `needs_attention`) when a charge has no
  `plan_tag`, and when a revoke can identify **no** customer at all — by email
  or by grant history — so the tag is never silently left on a cancelled member.
  A revoke has no quiet no-op path; every branch logs.
- **Logs go to a file as well as stdout** (`LOG_FILE`, default
  `./logs/membership.log`, size-rotated). A webhook that fails after we've
  already 200'd it is never redelivered, so that line is the only record it
  happened — it must not depend on stdout being captured.

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

- `read_customers`, `write_customers` (this service only reads/writes customer
  tags — no store-credit scopes needed)

The service verifies auth at boot: look for `"msg":"shopify auth ready"` with
`source` (`static` / `offline` / `client_credentials`) in the logs, or a loud
`needs_attention` error if auth isn't set up yet. Run `npm run verify:shopify`
any time to check auth **and** the `read_customers` scope in one shot.

### 3. Plans

Define your tiers in `plans.json` — one entry per storefront membership button:

```json
{
  "gold":   { "razorpayPlanId": "plan_ABC123", "tag": "membership-gold" },
  "silver": { "razorpayPlanId": "plan_DEF456", "tag": "membership-silver" }
}
```

- **key** (`gold`) — what the storefront button passes as `?plan=gold`.
- **razorpayPlanId** — the Razorpay Subscriptions plan (Dashboard → Subscriptions
  → Plans); its amount is that tier's monthly fee.
- **tag** — the customer tag applied while the membership is active and removed
  when it ends. This is what the storefront gates on.

Keys starting with `_` (e.g. `_comment`) are ignored. The catalog is validated
at boot — a missing/blank `razorpayPlanId` or `tag` crashes startup with a clear
message. Override the path with `PLANS_PATH` if needed.

### 4. Razorpay

1. Create a monthly **Plan** per tier (Dashboard → Subscriptions → Plans) and put
   each plan id in `plans.json` (above).
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

### 5. Run

```bash
npm start        # loads .env; equivalent to: node --env-file-if-exists=.env src/server.js
npm test         # signed-webhook end-to-end tests, Shopify mocked
```

## API

### `POST /join`

```json
{ "plan": "gold" }
```

`plan` is required and must be a key in `plans.json` (unknown/missing → 400). No
customer info — the member enters that on Razorpay. Returns:

```json
{ "subscriptionId": "sub_…", "shortUrl": "https://rzp.io/i/…" }
```

Send the member to `shortUrl` to authorize autopay.

### `GET /join/redirect?plan=…`

Same, but 302s straight to the Razorpay page — so each storefront plan button is
a plain static link (no customer object, works for logged-out visitors):

```liquid
<a href="https://membership.renmoda.in/join/redirect?plan=gold">Join Gold</a>
<a href="https://membership.renmoda.in/join/redirect?plan=silver">Join Silver</a>
```

On any failure (missing/unknown plan, Razorpay error) it 302s to
`JOIN_FAILURE_URL`.

> The join flow **must** go through this backend: each member needs their own
> subscription with the **plan tag** in `notes`, and identity is later resolved
> from the email Razorpay collects. Never hand out one shared payment link — the
> webhook would have no per-member subscription to key on.

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

One JSON line per event, written to **both** stdout/stderr and the rotating log
file (`LOG_FILE`, default `./logs/membership.log`; `LOG_MAX_BYTES` /
`LOG_MAX_FILES` tune rotation, `LOG_FILE=off` disables the file). The file is the
copy that survives a supervisor which discards stdout. The line to alert on:

```
"msg":"EVENT PROCESSING FAILED AFTER ACK — needs manual attention","needs_attention":true
```

Razorpay will **not** redeliver an event we already 200'd, so these need a
human. Reconciliation query for a member's tag history:

```bash
sqlite3 data/membership.db \
  "SELECT created_at, event_type, action, tag, note
   FROM membership_log WHERE shopify_customer_id LIKE '%<numeric id>' ORDER BY id;"
```

A `processed_events` row with **no** matching `membership_log` rows for a
`subscription.charged` event means processing died mid-flight (crash/API
failure) — re-apply the tag by hand in Shopify admin.

### A cancellation didn't remove the tag

Work down the log file — each step distinguishes the next possibility:

```bash
grep '"eventType":"subscription.cancelled"' logs/membership.log
```

1. **No `"msg":"webhook received"` line at all** — the event never reached us.
   Either `subscription.cancelled` isn't in the Razorpay dashboard's active
   events, or the cancellation was scheduled for cycle end (Razorpay only emits
   `subscription.cancelled` when it actually takes effect, not when it's
   requested). Check the subscription's status in the Razorpay dashboard.
2. **`webhook rejected: bad signature`** — `RAZORPAY_WEBHOOK_SECRET` doesn't
   match the dashboard.
3. **`revoke: start` then nothing** — see which branch logged next:
   - `revoke: no Shopify customer matches the Razorpay email` — the payment
     email and the Razorpay customer email diverge. Expect a following
     `revoke: recovered the customer from this subscription's grant history`;
     the `grantedToEmail` field shows the address the tag was actually applied
     under.
   - `revoke: Razorpay customer lookup failed` — Razorpay API error; the grant
     history fallback runs next.
   - `EVENT PROCESSING FAILED AFTER ACK` with `NOT removed` — neither route
     identified anyone. If the subscription was never charged, no tag was ever
     applied and this is safe to ignore; otherwise remove the tag in Shopify
     admin by hand.
4. **`plan tag revoked`** — we removed it. `identifiedVia` says how
   (`razorpay_email` or `grant_history`), `clearedTags` is what we asked Shopify
   to remove, and `customerTags` is what the customer was left holding —
   straight from Shopify's mutation response, so it's the authoritative answer
   to "did the tag actually come off?". If a plan tag is still in
   `customerTags`, it isn't in `plans.json` and wasn't this subscription's
   `notes.plan_tag`; add it to the catalog or clear it by hand.

Note that grant history only covers subscriptions **charged since this version
was deployed** — rows written earlier have no `subscription_id`, so an older
member with a divergent email falls through to the loud failure in step 3.

### VPS deploy (Hetzner + systemd + Caddy)

`/etc/systemd/system/renmoda-membership.service`:

```ini
[Unit]
Description=Renmoda membership service (Razorpay -> Shopify plan tags)
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
