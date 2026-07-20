# DataPurge Reply Mailbox (`relay/`)

A paid, inbound-only email alias service. Users get a private address,
`u-{slug}@{relay domain}`, that they hand to data brokers as their contact
address (and type into broker request forms). Broker replies land here, get
classified, and are relayed to the user's real inbox. A sealed copy of each
reply is kept as the user's evidence trail.

**We never email brokers.** The relay only ever emails the user who owns the
alias. Outbound first-contact through our domain is deliberately out of scope
(ESP AUPs forbid it, and it would break the site's promise).

This Worker is a sibling to `worker/` (the drip service) and does not touch it;
it reuses its patterns (double-opt-in, CORS/JSON helpers, cron purge,
`wrangler.toml` conventions) with its own D1 database.

## Architecture

One Worker, three handlers (`src/index.js`):

- **`email(message)`** - inbound catch-all. Gates on the slug regex
  `^u-[a-z2-9]{8}$`; rejects unknown/deleted aliases with SMTP 550 (no
  backscatter, nothing stored); metadata-logs-and-drops for
  paused/blocked/strict/over-cap; otherwise parses in memory
  ([`postal-mime`](https://www.npmjs.com/package/postal-mime)), classifies,
  resolves the broker from the sender domain, re-wraps the message
  (`From: "{sender} via DataPurge" <alias>`, `Reply-To:` the original sender,
  `To:` the real inbox, `Subject: [DataPurge/{class}] ...`, threading headers
  preserved, plain footer), sends via the `EMAIL` binding, and (in
  `ctx.waitUntil`) logs the reply with a sealed body, bumps counters, and
  upserts aggregate broker stats.
- **`fetch(request)`** - the app-facing API (see below).
- **`scheduled()`** - daily: purge 7-day-old unconfirmed claims, roll the
  monthly relay counter, refresh `broker_domains` from the live `registry.json`,
  and sweep entitlements (pause aliases > 30 days past `paid_until`).

Modules:

- `src/classify.js` - pure, dependency-free classifier
  (`ack | verification_required | completed | rejected_use_form | bounce_ndr | unrelated`),
  plus `extractDomain()` (eTLD+1 approximation) and `DSAR_VENDOR_DOMAINS`.
- `src/seal.js` - pure WebCrypto ECIES sealed-box (ECDH P-256 ephemeral +
  HKDF-SHA256 + AES-256-GCM). `seal()` runs in the Worker; `open()` mirrors the
  in-browser evidence viewer. The Worker holds only the public key.
- `schema.sql` - the five D1 tables (`aliases`, `blocked_senders`, `reply_log`,
  `broker_stats`, `broker_domains`) and indexes.

### API contract

CORS: allows `SITE_URL` and `http://localhost:8080`; methods `GET, POST, OPTIONS`;
headers `Authorization, Content-Type`. All errors are JSON `{error:"..."}`.

Authenticated endpoints expect `Authorization: Bearer {slug}.{secret}` where
`slug` is the full local part (`u-abc23xyz`) and `secret` is the 32-byte
base64url string generated at confirm. The server stores only `sha256(secret)`
and compares in constant time.

| Method + path | Auth | Body / query | Returns |
|---|---|---|---|
| `POST /api/claim` | - | `{email, pubkey}` | `SKIP_PAYMENT=1`: `{status:"pending_confirm"}` (sends confirm mail). Else `{checkout_url}` (Stripe Checkout, subscription mode). `409 {error}` if the email already has an alias. |
| `POST /api/stripe/webhook` | Stripe sig | Stripe event | `checkout.session.completed` -> mark paid + send confirm mail; `customer.subscription.deleted` -> pause + clear `paid_until`. |
| `GET /api/confirm?token=` | token | - | Activates, generates the secret, `302` to `${SITE_URL}/app.html#relay={slug}@{RELAY_DOMAIN}:{secret}`. |
| `GET /api/replies?since=ISO` | yes | `since` | `{replies:[{id, broker_id, sender_domain, classification, subject, received_at, relay_status}]}`, ascending, max 500. |
| `GET /api/evidence/{id}` | yes | - | `{id, sealed, classification, sender_domain, received_at}`. |
| `GET /api/alias` | yes | - | `{alias, status, strict_mode, paid_until, relay_count_month, blocked_domains}`. |
| `POST /api/alias/settings` | yes | `{paused?, strict_mode?, block_domain?, unblock_domain?}` | `{ok:true}`. |
| `POST /api/alias/delete` | yes | - | Nulls `real_email`/`pubkey`/`secret_hash`, purges `reply_log` + `blocked_senders`, tombstones the slug (`status='deleted'`). `{ok:true}`. |
| `POST /api/admin/refresh-domains` | `X-Admin-Key` | - | Runs the registry refresh now. `{ok:true, domains:N}`. |

## Development

```bash
npm install                 # postal-mime + wrangler
npm test                    # node --test on classify + seal (no wrangler needed)
npx wrangler dev --local    # local Worker + D1
```

`src/classify.js` and `src/seal.js` are pure and run under plain `node`; the test
suite imports them directly (no wrangler, no network). `src/index.js` imports
`postal-mime` and `cloudflare:email` and only runs inside Workers.

Config vars live in `wrangler.toml` (`RELAY_DOMAIN`, `SITE_URL`, `REGISTRY_URL`,
`MONTHLY_RELAY_CAP`, `SKIP_PAYMENT`). Secrets are set with `wrangler secret put`:
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `ADMIN_KEY`.

## Launch checklist (owner actions, in order)

1. **Buy the relay domain** (cheap, brand-detachable, e.g. a `purgereply.com`
   style name; NOT under `iamnottheproduct.com`) and add it as a Cloudflare zone.
2. **Upgrade the account to Workers Paid** ($5/mo).
3. **Onboard the domain to Email Sending** (beta).
   - **DISABLE "Email preview" on the domain immediately.** Cloudflare stores
     full sent bodies, headers, attachments and raw messages for ~7 days, and
     this is DEFAULT-ON for domains onboarded on/after 2026-07-02 (ours will be).
     Toggle it off at onboarding and **verify it is off before the first real
     relay** (the Activity log must show no preview).
4. **Enable Email Routing** on the domain: catch-all -> this Worker.
5. **Publish SPF/DKIM** as Email Sending instructs; add **DMARC `p=none`**, then
   move to `p=quarantine` after a clean week of monitoring.
6. **Create the D1 database and migrate:**
   ```bash
   npx wrangler d1 create datapurge-relay      # paste the id into wrangler.toml
   npm run db:migrate:prod                       # applies schema.sql
   ```
   Replace the `REPLACE-AT-DEPLOY` `database_id` and `REPLACE-RELAY-DOMAIN.example`
   markers in `wrangler.toml`, and uncomment the `routes` block for
   `api.{relay domain}`.
7. **Set secrets:**
   ```bash
   npx wrangler secret put STRIPE_SECRET_KEY
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   npx wrangler secret put STRIPE_PRICE_ID
   npx wrangler secret put ADMIN_KEY
   ```
8. **Stripe:** create the product + recurring price; create a webhook endpoint
   pointed at `https://api.{relay domain}/api/stripe/webhook` subscribed to
   `checkout.session.completed` and `customer.subscription.deleted`; copy its
   signing secret into `STRIPE_WEBHOOK_SECRET` and the price id into
   `STRIPE_PRICE_ID`. (14-day trial optional at price config.)
   Known limitation: `POST /api/alias/delete` tombstones the alias locally but
   does NOT cancel the Stripe subscription - cancel it in the Stripe dashboard
   when a user deletes, or add the API call in a later phase.
9. **Deploy** (`npm run deploy`) and **seed the broker-domain map**:
   ```bash
   curl -X POST https://api.{relay domain}/api/admin/refresh-domains \
     -H "X-Admin-Key: <ADMIN_KEY>"
   ```
   (The daily cron refreshes it thereafter.)
10. **Get written Cloudflare confirmation** that the 1:1 double-opt-in relay
    pattern fits Email Sending's transactional-only policy.
11. **Request a send-quota increase** before public launch.

### Staging test matrix (on the real domain, owner's own alias, pre-launch)

Send one real message per class from an external Gmail/Outlook and verify:

- Unknown slug -> SMTP 550, no `reply_log` row.
- Active alias -> relayed copy arrives; `reply_log` row with a sealed body.
- Paused / blocked / strict / over-cap -> metadata row only, no relay.
- `mailer-daemon` NDR -> classified `bounce_ndr`.
- On the relayed copy: SPF/DKIM/DMARC pass (Gmail "Show original" +
  mail-tester), `Reply-To` routes back to the original broker sender, and
  threading holds.
- Sealed-box round trip: the stored ciphertext opens in the browser evidence
  viewer with the localStorage key and fails with a wrong key.
- Stripe test mode: checkout -> webhook -> activation; cancel the subscription
  -> alias pauses.

## Privacy posture (what to disclose)

- **What we store:** per reply, the subject line (plaintext, for the in-app
  list), a sealed-box ciphertext of the body sealed to your public key, and
  metadata (sender domain as eTLD+1, classification, timestamps, relay status).
  Aggregate broker-behavior counters carry **no** user linkage.
- **Sealed box:** reply bodies are encrypted to a key that only your browser
  holds. The Worker has only your public key, so it can seal but can never open;
  we (and Cloudflare) hold ciphertext only. The evidence view decrypts locally.
- **What Cloudflare processes:** it relays mail in transit and, per its DPA, is
  contractually barred from using it for anything beyond delivery. With "Email
  preview" disabled it keeps no message bodies beyond transient processing. Its
  GraphQL analytics retain from/to/subject/message-id **metadata** for ~31 days
  on both the Routing and Sending sides (not togglable); the Routing Activity
  Log shows sender addresses; CF staff have narrow, access-controlled debugging
  reach. The accurate claim is the narrow one, never an absolute "nobody ever
  sees anything".
- **We never log content:** the Worker logs ids and classifications only, never
  bodies, subjects, or addresses. The confirm secret travels only in the URL
  fragment and is never logged server-side.
- **Retention is a feature:** records are your proof trail and are kept until
  you delete the alias, which purges everything and tombstones the slug so it
  can never be re-issued.
