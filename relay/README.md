# DataPurge Reply Mailbox (`relay/`)

A paid, inbound-only email alias service. Users get a private address,
`u-{slug}@{relay domain}`, that they hand to data brokers as their contact
address (and type into broker request forms). Broker replies land here, get
classified, and are relayed to the user's real inbox. A sealed copy of each
reply is kept as the user's evidence trail.

**We never email brokers.** The relay only ever emails the user who owns the
alias - the relayed copy of a broker reply, and the one-time confirmation mail.
Outbound first-contact through our domain is deliberately out of scope.

Inbound mail arrives over Cloudflare Email Routing (catch-all -> this Worker).
Outbound mail leaves over Scaleway Transactional Email (TEM), an EU processor
(FR/NL, ISO 27001, with a DPA). Cloudflare therefore only ever sees mail in
transit on the inbound side; it is never the outbound sender.

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
  preserved, plain footer), sends it through Scaleway TEM
  (`src/tem.js`), and (in `ctx.waitUntil`) logs the reply with a sealed body,
  bumps counters, and upserts aggregate broker stats. A TEM 2xx means the
  message is QUEUED; the actual delivery outcome arrives later on the webhook.
- **`fetch(request)`** - the app-facing API (see below), including the TEM
  delivery webhook.
- **`scheduled()`** - daily: purge 7-day-old unconfirmed claims, roll the
  monthly relay counter, refresh `broker_domains` from the live `registry.json`,
  and sweep entitlements (pause aliases > 30 days past `paid_until`).

Modules:

- `src/tem.js` - pure, node-testable Scaleway TEM client. `buildTemPayload()`
  assembles the exact request body (Reply-To / In-Reply-To / References ride
  `additional_headers`) and applies the attachment policy (MIME whitelist, then
  a ~1.8 MB encoded budget under TEM's 2 MB request limit; non-whitelisted files
  are dropped with a per-file note, and if the survivors still overflow they are
  all stripped with a size note). `sendViaTem()` POSTs it (injectable `fetchImpl`
  for tests) and returns the queued message id. `parseTemNotification()` and
  `decideTemAction()` interpret the delivery webhook.
- `src/classify.js` - pure, dependency-free classifier
  (`ack | verification_required | completed | rejected_use_form | bounce_ndr | unrelated`),
  plus `extractDomain()` (eTLD+1 approximation) and `DSAR_VENDOR_DOMAINS`.
- `src/seal.js` - pure WebCrypto ECIES sealed-box (ECDH P-256 ephemeral +
  HKDF-SHA256 + AES-256-GCM). `seal()` runs in the Worker; `open()` mirrors the
  in-browser evidence viewer. The Worker holds only the public key.
- `schema.sql` - the five D1 tables (`aliases`, `blocked_senders`, `reply_log`,
  `broker_stats`, `broker_domains`) and indexes. `reply_log.tem_email_id` keys
  the delivery webhook back to a stored reply.

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
| `POST /api/tem/webhook?k=` | token | Scaleway Topics-and-Events POST | `SubscriptionConfirmation` -> fetch the (Scaleway-host) `SubscribeURL` to confirm; `Notification` -> update `relay_status` / pause on bounce / pause on blocklist. Always `200` fast. |
| `GET /api/confirm?token=` | token | - | Activates, generates the secret, `302` to `${SITE_URL}/app.html#relay={slug}@{RELAY_DOMAIN}:{secret}`. |
| `GET /api/replies?since=ISO` | yes | `since` | `{replies:[{id, broker_id, sender_domain, classification, subject, received_at, relay_status}]}`, ascending, max 500. |
| `GET /api/evidence/{id}` | yes | - | `{id, sealed, classification, sender_domain, received_at}`. |
| `GET /api/alias` | yes | - | `{alias, status, strict_mode, paid_until, relay_count_month, blocked_domains}`. |
| `POST /api/alias/settings` | yes | `{paused?, strict_mode?, block_domain?, unblock_domain?}` | `{ok:true}`. |
| `POST /api/alias/delete` | yes | - | Nulls `real_email`/`pubkey`/`secret_hash`, purges `reply_log` + `blocked_senders`, tombstones the slug (`status='deleted'`). `{ok:true}`. |
| `POST /api/admin/refresh-domains` | `X-Admin-Key` | - | Runs the registry refresh now. `{ok:true, domains:N}`. |

The TEM webhook maps delivery events to actions: `delivered` / `deferred` /
`spam` update the reply row's `relay_status`; `dropped` / `mailbox_not_found`
mark a `permanent_bounce` and pause the owning alias; `blocklisted` /
`blocklist_created` pause the alias by recipient address (this also catches a
confirm-mail bounce that never produced a `reply_log` row - the pending claim
ages out via the 7-day purge). The endpoint logs event type and message id only,
never an address.

## Development

```bash
npm install                 # postal-mime + wrangler
npm test                    # node --test on classify, seal, tem, webhook (no wrangler needed)
npx wrangler dev --local    # local Worker + D1
```

`src/classify.js`, `src/seal.js`, and `src/tem.js` are pure and run under plain
`node`; the test suite imports them directly (no wrangler, no network - the TEM
send path takes an injectable `fetchImpl`). `src/index.js` no longer imports any
`cloudflare:*` module, so it also loads under plain `node` once `postal-mime` is
installed (a smoke test asserts this and skips if the dependency is absent).

Config vars live in `wrangler.toml` (`RELAY_DOMAIN`, `SITE_URL`, `REGISTRY_URL`,
`MONTHLY_RELAY_CAP`, `TEM_REGION`, `SKIP_PAYMENT`). Secrets are set with
`wrangler secret put`: `SCW_SECRET_KEY`, `SCW_PROJECT_ID`, `TEM_WEBHOOK_TOKEN`,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `ADMIN_KEY`.

## Launch checklist (owner actions, in order)

1. **Buy the relay domain** (cheap, brand-detachable, e.g. a `purgereply.com`
   style name; NOT under `iamnottheproduct.com`) and add it as a Cloudflare zone.
2. **Create a Scaleway account and project** on pay-as-you-go, and accept the
   Scaleway Data Processing Agreement for the project. TEM billing is usage-based
   (roughly EUR 16/mo at about 100 users).
3. **Add the relay domain to Scaleway TEM** in the `fr-par` region and complete
   domain verification. Publish the DNS records TEM asks for:
   - the TEM **SPF include** (merge it into any existing SPF record - one SPF
     record only),
   - the TEM **DKIM** record,
   - keep **DMARC** at `p=none` to start, then move to `p=quarantine` after a
     clean week of monitoring.
4. **Enable Cloudflare Email Routing** on the domain: catch-all -> this Worker.
   Its **MX records stay** - they serve inbound mail and also satisfy TEM's
   recommendation that a sending domain have valid MX.
5. **Create a scoped IAM application and API key in Scaleway** with permissions
   limited to Transactional Email for this project. Its **secret key** becomes
   `SCW_SECRET_KEY`; note the **project id** for `SCW_PROJECT_ID`.
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
   npx wrangler secret put SCW_SECRET_KEY
   npx wrangler secret put SCW_PROJECT_ID
   npx wrangler secret put TEM_WEBHOOK_TOKEN     # a long random string you choose
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
10. **Wire the TEM delivery webhook** (TEM has no HMAC signing, so the token in
    the URL is the gate):
    - In Scaleway **Topics and Events**, create a topic and an **HTTPS
      subscription** whose endpoint is
      `https://api.{relay domain}/api/tem/webhook?k=<TEM_WEBHOOK_TOKEN>`. The
      first POST is a `SubscriptionConfirmation`; the Worker confirms it
      hands-free (it only ever fetches a `*.scaleway.com` `SubscribeURL`).
    - Create the **TEM email webhook** for the domain, attach the topic's ARN
      (`sns_arn`), and subscribe the seven email event types: `email_delivered`,
      `email_deferred`, `email_dropped`, `email_mailbox_not_found`,
      `email_blocklisted`, `email_spam`, `email_queued`. Blocklist events are
      also consumed. Note: PAYG allows **one webhook per domain**.
11. **File the send-quota increase ticket BEFORE public launch** (Appendix A).
    The default TEM quota is 10,000/month; we ask for 30,000. This ticket is the
    written go/no-go gate - do not open to the public until it is approved.

The account runs on the **Workers Free tier**; TEM removes the old
Workers-Paid requirement. The only caveat is the free-tier 10 ms CPU limit on a
single request. If the logs ever show inbound handling hitting that ceiling on
large messages, upgrade to Workers Paid - nothing else changes.

### Staging test matrix (on the real domain, owner's own alias, pre-launch)

Send one real message per class from an external Gmail/Outlook and verify:

- Unknown slug -> SMTP 550, no `reply_log` row.
- Active alias -> relayed copy arrives; `reply_log` row with a sealed body and a
  `tem_email_id`.
- Paused / blocked / strict / over-cap -> metadata row only, no relay.
- `mailer-daemon` NDR -> classified `bounce_ndr`.
- On the relayed copy: SPF/DKIM/DMARC pass (Gmail "Show original" +
  mail-tester), `Reply-To` routes back to the original broker sender, and
  threading holds.
- TEM webhook: a `delivered` event upgrades the row's `relay_status`; force a
  `dropped` / `mailbox_not_found` (send to a known-dead address) and confirm the
  row flips to `permanent_bounce` and the alias pauses.
- Attachment policy: a whitelisted PDF rides through; a `.zip` is dropped with
  the per-file note; an oversize set is stripped with the size note.
- Sealed-box round trip: the stored ciphertext opens in the browser evidence
  viewer with the localStorage key and fails with a wrong key.
- Stripe test mode: checkout -> webhook -> activation; cancel the subscription
  -> alias pauses.

## Privacy posture (what to disclose)

- **What we store:** per reply, the subject line (plaintext, for the in-app
  list), a sealed-box ciphertext of the body sealed to your public key, and
  metadata (sender domain as eTLD+1, classification, timestamps, relay status,
  the TEM message id). Aggregate broker-behavior counters carry **no** user
  linkage.
- **Sealed box:** reply bodies are encrypted to a key that only your browser
  holds. The Worker has only your public key, so it can seal but can never open;
  we (and our providers) hold ciphertext only. The evidence view decrypts
  locally.
- **Cloudflare is inbound transit only.** It receives broker mail over Email
  Routing and hands it to the Worker; it is never the outbound sender, so it
  stores no sent bodies. Its GraphQL analytics retain inbound from/to/subject/
  message-id **metadata** for ~31 days (not togglable), and the Routing Activity
  Log shows sender addresses. The accurate claim is the narrow one, never an
  absolute "nobody ever sees anything".
- **Scaleway is the outbound processor.** It sends the relayed copy and the
  confirmation mail from EU infrastructure (FR/NL), is ISO 27001 certified, and
  processes under its DPA - contractually barred from using the mail for
  anything beyond delivery. It necessarily handles the outbound message in
  transit and retains delivery metadata (recipient, message id, event history)
  for its own reporting and the delivery webhook.
- **We never log content:** the Worker logs ids and classifications only, never
  bodies, subjects, or addresses. The TEM webhook logs event type and message id
  only. The confirm secret travels only in the URL fragment and is never logged
  server-side.
- **Retention is a feature:** records are your proof trail and are kept until
  you delete the alias, which purges everything and tombstones the slug so it
  can never be re-issued.

## Appendix A - Scaleway TEM quota-increase ticket

File this before public launch and treat approval as the go/no-go gate. Fill in
the bracketed values.

> **Subject:** Transactional email monthly quota increase - inbound reply relay
>
> **Project:** [Scaleway project id]
> **Sending domain:** [relay domain] (region fr-par)
> **Current monthly quota:** 10,000
> **Requested monthly quota:** 30,000
>
> **What the service is.** DataPurge is an open-source privacy tool that helps
> people exercise their data-protection rights by sending opt-out and deletion
> requests to data brokers. Each user is issued a private, inbound-only alias
> (`u-{slug}@[relay domain]`) that they give to brokers as their contact
> address. When a broker replies to that alias, our relay forwards a single copy
> to the user's own inbox and sends nothing else. We do not send first-contact,
> bulk, or marketing mail from this domain, and we never email brokers from it.
>
> **Consent.** Every address we send to is the user's own inbox, captured
> through double opt-in: the user enters their address, we send one confirmation
> link, and no relay mail is ever sent until they click it. We hold explicit,
> logged consent for every recipient, and the user can pause or delete their
> alias at any time (which purges their records).
>
> **Legal basis.** Independently of consent, the mail is transactional
> correspondence the user asked us to relay while exercising a legal right - a
> data subject access or deletion request under the GDPR, UK GDPR, CCPA/CPRA,
> and equivalent US state laws. That is a lawful basis in its own right. There
> is no mailing list and no promotional content.
>
> **Volume shape.** Mail is one-to-one and reply-triggered, never campaign
> based. We cap relay volume at 300 messages per alias per month in software, so
> total volume is bounded and predictable. The 30,000/month figure covers about
> 100 active users at that cap with headroom.
>
> **Deliverability handling.** We consume TEM delivery webhooks (delivered,
> deferred, dropped, mailbox_not_found, blocklisted, spam, blocklist_created). A
> dropped or mailbox_not_found event automatically pauses the owning alias; a
> blocklist event pauses by recipient address. This keeps our bounce and
> complaint rates low by design.
