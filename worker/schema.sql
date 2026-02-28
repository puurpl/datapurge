-- DataPurge Drip Service — D1 Schema
-- Run: wrangler d1 execute datapurge-drip --file=schema.sql

CREATE TABLE IF NOT EXISTS subscribers (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    brokers_per_email INTEGER NOT NULL DEFAULT 100,
    queue_position INTEGER NOT NULL DEFAULT 0,
    total_items INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_sent_at TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    rotation_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS queue_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    broker_id TEXT NOT NULL,
    broker_name TEXT NOT NULL,
    email_to TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    nc_subject TEXT NOT NULL DEFAULT '',
    nc_body TEXT NOT NULL DEFAULT '',
    first_sent_at TEXT,
    FOREIGN KEY (subscriber_id) REFERENCES subscribers(id)
);

CREATE TABLE IF NOT EXISTS sent_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id TEXT NOT NULL,
    queue_item_id INTEGER NOT NULL,
    sent_at TEXT NOT NULL,
    rotation INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (subscriber_id) REFERENCES subscribers(id),
    FOREIGN KEY (queue_item_id) REFERENCES queue_items(id)
);

CREATE INDEX IF NOT EXISTS idx_queue_items_subscriber ON queue_items(subscriber_id, position);
CREATE INDEX IF NOT EXISTS idx_sent_log_subscriber ON sent_log(subscriber_id, rotation);
CREATE INDEX IF NOT EXISTS idx_sent_log_compliance ON sent_log(subscriber_id, rotation, sent_at);
