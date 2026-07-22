-- DataPurge Reply Mailbox - D1 schema
-- Run: wrangler d1 execute datapurge-relay --file=schema.sql
--
-- Privacy posture: reply bodies are NEVER stored in plaintext. body_sealed
-- holds a sealed-box ciphertext (base64) that only the user's private key can
-- open; the Worker holds only the public key. Subjects are stored plaintext for
-- the in-app list view (disclosed to the user). broker_stats carry NO user
-- linkage - they aggregate broker behavior only.

-- One inbound alias per user. real_email / pubkey / secret_hash are nulled on
-- deletion, leaving the slug as a tombstone so it can never be re-issued.
CREATE TABLE IF NOT EXISTS aliases (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,              -- full local part, matches ^u-[a-z2-9]{8}$
    real_email TEXT UNIQUE,                 -- user's real inbox; NULL after delete
    pubkey TEXT,                            -- raw P-256 public key (base64) for sealing
    secret_hash TEXT,                       -- sha256 hex of the API secret; set at confirm
    status TEXT NOT NULL DEFAULT 'pending', -- pending|active|paused|disabled|deleted
    strict_mode INTEGER NOT NULL DEFAULT 0, -- 1 = only relay mail from known brokers
    confirm_token TEXT,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    paid_until TEXT,                        -- ISO; entitlement horizon
    created_at TEXT NOT NULL,
    confirmed_at TEXT,
    last_relay_at TEXT,
    relay_month TEXT,                       -- 'YYYY-MM' the counter belongs to
    relay_count_month INTEGER NOT NULL DEFAULT 0
);

-- Per-alias sender-domain blocklist.
CREATE TABLE IF NOT EXISTS blocked_senders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alias_id TEXT NOT NULL,
    sender_domain TEXT NOT NULL,
    FOREIGN KEY (alias_id) REFERENCES aliases(id)
);

-- One row per inbound reply (relayed or dropped). body_sealed is the sealed-box
-- ciphertext; NULL for metadata-only drops (paused/blocked/strict/over-cap).
CREATE TABLE IF NOT EXISTS reply_log (
    id TEXT PRIMARY KEY,                    -- evidence id (uuid)
    alias_id TEXT NOT NULL,
    broker_id TEXT,                         -- resolved from sender domain; NULL if unknown
    sender_domain TEXT,                     -- eTLD+1 of the sender
    classification TEXT,                    -- ack|verification_required|completed|rejected_use_form|bounce_ndr|unrelated
    subject TEXT,
    body_sealed TEXT,                       -- base64 sealed-box ciphertext; NULL if not stored
    msgid_hash TEXT,                        -- sha256 of Message-ID for dedup
    received_at TEXT NOT NULL,
    relayed INTEGER NOT NULL DEFAULT 0,
    relay_status TEXT,                      -- relayed|paused|blocked|strict_drop|over_cap|send_failed|permanent_bounce|parse_error|delivered|deferred|spam_flagged|blocklisted
    tem_email_id TEXT,                      -- Scaleway TEM message id (emails[0].id); NULL for drops. Webhook upgrades relay_status by this key.
    FOREIGN KEY (alias_id) REFERENCES aliases(id)
);

-- Aggregate broker behavior. NO user linkage - keyed by broker + month only.
CREATE TABLE IF NOT EXISTS broker_stats (
    broker_id TEXT NOT NULL,
    month TEXT NOT NULL,                    -- 'YYYY-MM'
    replies INTEGER NOT NULL DEFAULT 0,
    verifications INTEGER NOT NULL DEFAULT 0,
    completions INTEGER NOT NULL DEFAULT 0,
    form_steers INTEGER NOT NULL DEFAULT 0,
    bounces INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (broker_id, month)
);

-- domain -> broker_id map, cron-refreshed from the live registry.json plus the
-- static DSAR-vendor allowlist (those rows carry a NULL broker_id).
CREATE TABLE IF NOT EXISTS broker_domains (
    domain TEXT PRIMARY KEY,
    broker_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_aliases_status ON aliases(status);
CREATE INDEX IF NOT EXISTS idx_aliases_subscription ON aliases(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_blocked_alias ON blocked_senders(alias_id, sender_domain);
CREATE INDEX IF NOT EXISTS idx_reply_log_alias ON reply_log(alias_id, received_at);
-- Dedup: at most one stored row per (alias, source Message-ID).
CREATE UNIQUE INDEX IF NOT EXISTS idx_reply_log_msgid ON reply_log(alias_id, msgid_hash);
-- TEM delivery webhook looks rows up by the queued message id.
CREATE INDEX IF NOT EXISTS idx_reply_log_tem ON reply_log(tem_email_id);
CREATE INDEX IF NOT EXISTS idx_broker_stats_broker ON broker_stats(broker_id, month);
