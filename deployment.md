# Deployment — Renmoda Membership Service (Hetzner VPS)

This is a runbook for putting this repo on a fresh VPS and going live. It's
written so you (or Claude Code running **on the VPS**) can execute it top to
bottom. Steps are tagged:

- 🤖 **agent/shell** — a command Claude Code can run on the VPS.
- 🌐 **DNS** — you create a DNS record (the one checkpoint that needs your
  registrar). Claude Code will print the exact record and pause here.
- 🖐️ **dashboard** — you click in the Shopify or Razorpay dashboard.

Target OS: Ubuntu 24.04 LTS. Service runs as a dedicated user under systemd,
behind Caddy (automatic HTTPS). App details live in `README.md`; this file is
only about getting it running publicly.

---

## 0. Before you start — decide these values

| Value | This deploy | Notes |
| --- | --- | --- |
| Public hostname | `membership.renmoda.in` | Your subdomain. Must match everywhere below. |
| Deploy dir | `/opt/renmoda-membership` | |
| Run-as user | `renmoda` | non-root |
| App port | `3000` | Caddy proxies to `127.0.0.1:3000` |
| DB path | `/opt/renmoda-membership/data/membership.db` | persistent — holds the Shopify token, dedupe memory, audit log |

**Pre-flight sanity checks on your current `.env` / `plans.json`** (fix before
going live — these are easy to miss):

- [ ] `RAZORPAY_TOTAL_COUNT` — currently `5`. That means a membership **auto-ends
      after 5 charges** (tag removed). For a real "until cancelled" membership set
      it to `120` (10 years).
- [ ] `plans.json` — currently one seeded plan `standard`. Add/rename your real
      tiers (each with its Razorpay plan id + the customer tag you want).
- [ ] `RAZORPAY_KEY_ID` is a **live** key (`rzp_live_…`) → real money will move.
      If you want to rehearse first, deploy with **test** keys, do a test
      subscription, then swap to live and restart.
- [ ] `SHOPIFY_SHOP` = `2813c5-4.myshopify.com` (the canonical domain — already
      correct).

> **The Shopify offline token you minted locally lives in your *local*
> `data/membership.db`.** We will **not** copy it. On the VPS you'll re-run the
> one-time OAuth install against the public URL (Step 8), so the VPS gets its
> own token. Start the VPS with a fresh `data/` dir.

---

## 1. 🤖 System prep

```bash
# As root (or with sudo):
apt update && apt -y upgrade

# Node.js 22 LTS (repo also fine with 20.18+)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Build tools — better-sqlite3 ships prebuilt binaries, but this is the
# fallback so `npm install` never fails on a fresh box:
apt install -y build-essential python3 git rsync

node -v   # expect v22.x (must be >= 20.18)
```

## 2. 🤖 Create the run-as user + directory

```bash
useradd --system --create-home --shell /usr/sbin/nologin renmoda
mkdir -p /opt/renmoda-membership
chown renmoda:renmoda /opt/renmoda-membership
```

## 3. Get the code + secrets onto the VPS

Pick **one**. Either way, `node_modules` and `data/` must **not** be copied
(rebuild deps on the VPS; start with a fresh DB).

**Option A — rsync from your laptop (simplest; brings `.env` securely over SSH):**

```bash
# Run this on your LAPTOP, from the repo root:
rsync -avz --exclude node_modules --exclude data --exclude .git \
  ./ root@<VPS_IP>:/opt/renmoda-membership/
```

**Option B — private git repo:**

```bash
# On the VPS:
git clone <your-private-repo-url> /opt/renmoda-membership
# .env is gitignored, so copy it separately from your laptop:
#   scp .env root@<VPS_IP>:/opt/renmoda-membership/.env
```

Then fix ownership:

```bash
chown -R renmoda:renmoda /opt/renmoda-membership
```

## 4. 🤖 Install dependencies + edit `.env` for production

```bash
cd /opt/renmoda-membership
sudo -H -u renmoda npm ci --omit=dev   # or: npm install --omit=dev
```

Edit `.env` and set/confirm these **production** values:

```dotenv
PORT=3000
DB_PATH=/opt/renmoda-membership/data/membership.db
# The public HTTPS callback — REQUIRED on the VPS (behind a proxy the request
# host isn't the public one). Must match your hostname + the Shopify allow-list.
SHOPIFY_REDIRECT_URI=https://membership.renmoda.in/oauth/callback
# ...all the Razorpay + Shopify values you already have locally...
```

Quick config check (loads `.env`, validates, fetches a Shopify token):

```bash
cd /opt/renmoda-membership
sudo -H -u renmoda npm run verify:shopify
# EXPECTED right now: it reaches Shopify but there's no offline token in THIS
# (fresh) DB yet, so it will say to run /oauth/install. That's Step 8 — proceed.
```

## 5. 🤖 systemd service

Write `/etc/systemd/system/renmoda-membership.service`:

```ini
[Unit]
Description=Renmoda membership service (Razorpay -> Shopify plan tags)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=renmoda
WorkingDirectory=/opt/renmoda-membership
# Load .env with Node's own parser (same one verify:shopify uses), rather than
# systemd EnvironmentFile — avoids any parsing differences on secret values.
ExecStart=/usr/bin/node --env-file=.env src/server.js
Restart=on-failure
RestartSec=5
# Let in-flight post-ack Shopify work drain on stop/deploy.
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now renmoda-membership
systemctl status renmoda-membership --no-pager
journalctl -u renmoda-membership -n 30 --no-pager
# EXPECTED: "msg":"listening" and a non-fatal "shopify auth check FAILED ...
# will retry" (no token in fresh DB yet — fixed in Step 8). Service stays up.
```

## 6. 🤖 Firewall + Caddy

```bash
# Firewall — 80 and 443 MUST be open (Caddy needs 80 for the cert challenge,
# Razorpay/Shopify reach you on 443). Keep 22 for SSH.
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
```

> If your VPS also has a **Hetzner Cloud Firewall** (in the Hetzner console),
> open inbound 22/80/443 there too — it sits in front of `ufw`.

Install Caddy and configure the reverse proxy:

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

Write `/etc/caddy/Caddyfile`:

```
membership.renmoda.in {
    reverse_proxy 127.0.0.1:3000
}
```

Don't reload Caddy yet — it can't get a certificate until DNS points here
(Step 7).

## 7. 🌐 DNS handoff  ← **the step you're waiting for**

Get the VPS public IP:

```bash
echo "IPv4: $(curl -4 -s https://ifconfig.me)"
echo "IPv6: $(curl -6 -s https://ifconfig.me 2>/dev/null || echo none)"
```

**Create this DNS record at your registrar / DNS provider for `renmoda.in`:**

| Type | Name | Value | TTL |
| --- | --- | --- | --- |
| `A` | `membership` | `<VPS_IPv4 from above>` | 300 |
| `AAAA` *(only if IPv6 shown above)* | `membership` | `<VPS_IPv6>` | 300 |

- If DNS is on **Cloudflare**, set the record to **DNS only (grey cloud)** so
  Caddy's HTTP-01 challenge works. (Or keep the proxy on and use Full/Strict
  SSL — grey cloud is simplest.)

Wait for it to resolve, then provision HTTPS:

```bash
dig +short membership.renmoda.in    # should return your VPS IPv4
systemctl reload caddy
sleep 5
curl -s https://membership.renmoda.in/healthz   # expect {"ok":true} over HTTPS
```

If `healthz` returns `{"ok":true}` over `https`, TLS is live and you're
publicly reachable.

## 8. 🖐️ + 🤖 Shopify: authorize the app on the VPS

1. 🖐️ **Dev Dashboard → your app → Allowed redirection URL(s)** → add:
   `https://membership.renmoda.in/oauth/callback`
2. 🖐️ In a browser, as the **store owner**, open:
   `https://membership.renmoda.in/oauth/install` → approve.
3. 🤖 Confirm the token landed in the VPS DB:

```bash
cd /opt/renmoda-membership && sudo -H -u renmoda npm run verify:shopify
# EXPECTED: source: offline  +  "All Shopify checks passed."
systemctl restart renmoda-membership   # picks up the freshly stored token cleanly
```

## 9. 🖐️ Razorpay: register the production webhook

**Dashboard → Account & Settings → Webhooks → Add New Webhook:**

- **URL:** `https://membership.renmoda.in/webhooks/razorpay`
- **Secret:** must **exactly equal** `RAZORPAY_WEBHOOK_SECRET` in your VPS `.env`
  (if you set a new one here, update `.env` and `systemctl restart`).
- **Active events** (subscribe to exactly these):
  `subscription.activated`, `subscription.charged`, `subscription.pending`,
  `subscription.halted`, `subscription.cancelled`, `subscription.completed`.

## 10. 🖐️ Storefront buttons

Add one plain link per plan (no customer object needed — works logged-out):

```liquid
<a href="https://membership.renmoda.in/join/redirect?plan=standard">Join</a>
```

---

## Go-live smoke test

```bash
curl -s https://membership.renmoda.in/healthz                 # {"ok":true}
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://membership.renmoda.in/join/redirect?plan=NOPE"     # 302 -> failure url
```

Then a real end-to-end (use a **test** Razorpay key first if you can): open a
plan button → complete authorization on Razorpay with a test email → watch:

```bash
journalctl -u renmoda-membership -f
# expect: "plan tag granted"  with newCustomer/inviteSent, and no
# "needs_attention" lines.
```

Confirm in Shopify Admin that the customer exists and carries the plan tag.

---

## Operations

- **Logs:** `journalctl -u renmoda-membership -f`. The line to alert on:
  `"needs_attention":true` (a paid event we already 200'd that failed — Razorpay
  won't redeliver it, so it needs a human).
- **Backups (important):** `data/membership.db` holds the Shopify offline token,
  webhook dedupe memory, and the tag audit log. Back it up:
  ```bash
  sudo -u renmoda sqlite3 /opt/renmoda-membership/data/membership.db \
    ".backup '/opt/renmoda-membership/data/backup-$(date +%F).db'"
  ```
  (Add to cron.) If you ever wipe this DB you must re-run Step 8 and you lose
  dedupe protection until it repopulates.
- **Redeploy:** rsync/pull new code (keep `data/` and `.env`), then
  `sudo -H -u renmoda npm ci --omit=dev && systemctl restart renmoda-membership`.
- **Rotate the Shopify token:** just re-run Step 8's `/oauth/install`.

---

## "Am I missing a step?" — the ones people forget

1. **Re-running OAuth on the VPS (Step 8).** The token you minted locally isn't
   on the VPS. Skipping this = every Shopify call fails.
2. **Adding the VPS callback URL to the Shopify allow-list** before Step 8, or
   `/oauth/install` errors.
3. **Ports 80 + 443 open** (both `ufw` and any Hetzner Cloud Firewall). Closed
   80 = no TLS cert; closed 443 = no webhooks.
4. **Webhook secret match** between the Razorpay dashboard and `.env`. A mismatch
   makes every webhook fail signature (401) silently to Razorpay.
5. **`SHOPIFY_REDIRECT_URI` set to the public HTTPS URL** on the VPS (behind the
   proxy it can't be derived reliably).
6. **`RAZORPAY_TOTAL_COUNT`** left at `5` → memberships self-cancel after 5
   months. Set `120` for production.
7. **`plans.json` has your real tiers**, and the storefront buttons use those
   exact plan keys.
8. **DB persistence + backup** — it's not just a cache; it holds your only copy
   of the offline token and the dedupe log.
