/**
 * DataPurge Reply Mailbox - Cloudflare Worker.
 *
 * One Worker, three handlers:
 *   email()     - inbound catch-all: classify a broker reply and relay it to the
 *                 user's real inbox, sealing the body into the evidence locker.
 *   fetch()     - the app-facing API (claim/confirm/replies/evidence/alias/...).
 *   scheduled() - daily housekeeping (pending purge, monthly reset, registry
 *                 refresh, Stripe entitlement sweep).
 *
 * We NEVER email brokers - the relay only ever emails the user who owns the
 * alias. Reply bodies are sealed to a user-held key before storage; the Worker
 * holds only the public key. Nothing that could carry content (bodies, subjects,
 * addresses) is ever logged - only ids and classifications.
 */

import PostalMime from 'postal-mime';
import { EmailMessage } from 'cloudflare:email';
import { classify, extractDomain, DSAR_VENDOR_DOMAINS } from './classify.js';
import { seal, b64encode } from './seal.js';

const ENC = new TextEncoder();
const MAX_ATTACH_BYTES = 4 * 1024 * 1024; // 4 MB total, else stub the attachments
const REPLIES_PAGE_MAX = 500;

// Maps a classification to the specific broker_stats counter (replies++ always).
const CLASS_COUNTER = {
    verification_required: 'verifications',
    completed: 'completions',
    rejected_use_form: 'form_steers',
    bounce_ndr: 'bounces',
};

// ===================================================================
// Small utilities
// ===================================================================

function currentMonth() {
    return new Date().toISOString().slice(0, 7); // 'YYYY-MM'
}

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function constantTimeEqual(a, b) {
    a = String(a);
    b = String(b);
    if (a.length !== b.length) return false;
    let r = 0;
    for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return r === 0;
}

async function sha256hex(str) {
    const buf = await globalThis.crypto.subtle.digest('SHA-256', ENC.encode(String(str)));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256Hex(secret, msg) {
    const key = await globalThis.crypto.subtle.importKey(
        'raw', ENC.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = await globalThis.crypto.subtle.sign('HMAC', key, ENC.encode(msg));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomSecret() {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
    return b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeSlug() {
    const alpha = 'abcdefghijklmnopqrstuvwxyz23456789'; // [a-z2-9]
    const r = globalThis.crypto.getRandomValues(new Uint8Array(8));
    let s = 'u-';
    for (let i = 0; i < 8; i++) s += alpha[r[i] % alpha.length];
    return s;
}

function toU8(content) {
    if (!content) return new Uint8Array(0);
    if (content instanceof Uint8Array) return content;
    if (content instanceof ArrayBuffer) return new Uint8Array(content);
    if (typeof content === 'string') return ENC.encode(content);
    try {
        return new Uint8Array(content);
    } catch {
        return new Uint8Array(0);
    }
}

// ===================================================================
// CORS + JSON helpers
// ===================================================================

function allowedOrigin(env, request) {
    const origin = request.headers.get('Origin');
    const allow = [env.SITE_URL, 'http://localhost:8080'];
    if (origin && allow.includes(origin)) return origin;
    return env.SITE_URL;
}

function corsHeaders(env, request) {
    return {
        'Access-Control-Allow-Origin': allowedOrigin(env, request),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Vary': 'Origin',
    };
}

function jsonResponse(data, status = 200, cors) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...(cors || {}) },
    });
}

// ===================================================================
// MIME builder (for relayed copies and confirmation mail)
// ===================================================================

function boundary() {
    return globalThis.crypto.randomUUID().replace(/-/g, '');
}

function b64wrap(b64) {
    return b64.replace(/(.{76})/g, '$1\r\n');
}

// RFC 2047 encode a header value if it contains non-ASCII.
function encodeHeaderValue(v) {
    const s = String(v == null ? '' : v);
    if (/^[\x00-\x7F]*$/.test(s)) return s.replace(/[\r\n]+/g, ' ');
    return `=?UTF-8?B?${b64encode(ENC.encode(s))}?=`;
}

function renderBody(text, html) {
    const textB64 = b64wrap(b64encode(ENC.encode(String(text || ''))));
    if (!html) {
        return {
            headers: ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64'],
            content: `${textB64}\r\n`,
        };
    }
    const bnd = `alt_${boundary()}`;
    const htmlB64 = b64wrap(b64encode(ENC.encode(String(html))));
    const content =
        `--${bnd}\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${textB64}\r\n` +
        `--${bnd}\r\nContent-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${htmlB64}\r\n` +
        `--${bnd}--\r\n`;
    return { headers: [`Content-Type: multipart/alternative; boundary="${bnd}"`], content };
}

function buildRawEmail(opts) {
    const {
        fromHeader, toHeader, replyTo, subject, references, inReplyTo, messageId,
        text, html, attachments,
    } = opts;

    const header = [];
    header.push(`From: ${fromHeader}`);
    header.push(`To: ${toHeader}`);
    if (replyTo) header.push(`Reply-To: ${replyTo}`);
    header.push(`Subject: ${encodeHeaderValue(subject || '(no subject)')}`);
    header.push(`Date: ${new Date().toUTCString()}`);
    header.push(`Message-ID: ${messageId}`);
    if (inReplyTo) header.push(`In-Reply-To: ${inReplyTo}`);
    if (references) header.push(`References: ${references}`);
    header.push('MIME-Version: 1.0');

    const attach = (attachments || []).filter(Boolean);
    const body = renderBody(text, html);

    if (attach.length === 0) {
        header.push(...body.headers);
        return `${header.join('\r\n')}\r\n\r\n${body.content}`;
    }

    const mixed = `mixed_${boundary()}`;
    header.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);
    let out = `--${mixed}\r\n${body.headers.join('\r\n')}\r\n\r\n${body.content}\r\n`;
    for (const att of attach) {
        const data = toU8(att.content);
        const fname = encodeHeaderValue(att.filename || 'attachment');
        out += `--${mixed}\r\n`;
        out += `Content-Type: ${att.mimeType || 'application/octet-stream'}; name="${fname}"\r\n`;
        out += 'Content-Transfer-Encoding: base64\r\n';
        out += `Content-Disposition: ${att.disposition || 'attachment'}; filename="${fname}"\r\n\r\n`;
        out += `${b64wrap(b64encode(data))}\r\n`;
    }
    out += `--${mixed}--\r\n`;
    return `${header.join('\r\n')}\r\n\r\n${out}`;
}

async function sendMail(env, opts) {
    const raw = buildRawEmail({
        fromHeader: opts.fromHeader || opts.fromAddr,
        toHeader: opts.to,
        replyTo: opts.replyTo,
        subject: opts.subject,
        references: opts.references,
        inReplyTo: opts.inReplyTo,
        messageId: `<${globalThis.crypto.randomUUID()}@${env.RELAY_DOMAIN}>`,
        text: opts.text,
        html: opts.html,
        attachments: opts.attachments,
    });
    const msg = new EmailMessage(opts.fromAddr, opts.to, raw);
    await env.EMAIL.send(msg);
}

function isPermanentBounce(err) {
    const m = String((err && err.message) || '').toLowerCase();
    return /permanent|550|5\.\d\.\d|does not exist|no such|not verified|rejected|invalid recipient|mailbox unavailable|address not found/.test(m);
}

// ===================================================================
// Inbound email handler
// ===================================================================

async function handleInboundEmail(message, env, ctx) {
    const localPart = String(message.to || '').split('@')[0].toLowerCase();

    // Slug gate: anything that is not a well-formed alias is a hard reject.
    if (!/^u-[a-z2-9]{8}$/.test(localPart)) {
        message.setReject('Unknown recipient');
        return;
    }

    const alias = await env.DB.prepare('SELECT * FROM aliases WHERE slug = ?')
        .bind(localPart).first();
    if (!alias || alias.status === 'deleted' || alias.status === 'disabled') {
        // 550 - no backscatter, nothing stored.
        message.setReject('Unknown recipient');
        return;
    }

    const fromAddr = String(message.from || '');
    const senderDomain = extractDomain(fromAddr);
    const origMessageId = message.headers.get('Message-ID') || message.headers.get('Message-Id') || '';
    const receivedAt = new Date().toISOString();
    const msgidHash = await sha256hex(origMessageId || `${fromAddr}|${receivedAt}|${globalThis.crypto.randomUUID()}`);
    const month = currentMonth();
    const monthCount = alias.relay_month === month ? alias.relay_count_month : 0;
    const cap = parseInt(env.MONTHLY_RELAY_CAP || '300', 10);

    const brokerRow = await env.DB.prepare('SELECT broker_id FROM broker_domains WHERE domain = ?')
        .bind(senderDomain).first();
    const brokerKnown = brokerRow !== null;
    const brokerId = brokerRow ? brokerRow.broker_id : null;

    const blocked = await env.DB.prepare(
        'SELECT 1 FROM blocked_senders WHERE alias_id = ? AND sender_domain = ?',
    ).bind(alias.id, senderDomain).first();

    // Drop conditions: metadata-log + silently drop (accept, do not relay, do
    // not reject). No parsing on this path - we never touch the body.
    let dropReason = null;
    if (alias.status === 'paused') dropReason = 'paused';
    else if (blocked) dropReason = 'blocked';
    else if (alias.strict_mode && !brokerKnown) dropReason = 'strict_drop';
    else if (monthCount >= cap) dropReason = 'over_cap';

    if (dropReason) {
        ctx.waitUntil(logMetadata(env, {
            aliasId: alias.id, brokerId, senderDomain, msgidHash, receivedAt, relayStatus: dropReason,
        }));
        return;
    }

    // Dedup: if this Message-ID was already handled for this alias, skip.
    if (origMessageId) {
        const dup = await env.DB.prepare(
            'SELECT 1 FROM reply_log WHERE alias_id = ? AND msgid_hash = ?',
        ).bind(alias.id, msgidHash).first();
        if (dup) return;
    }

    // Parse in-memory only.
    let parsed;
    try {
        const buf = await new Response(message.raw).arrayBuffer();
        parsed = await new PostalMime().parse(buf);
    } catch {
        ctx.waitUntil(logMetadata(env, {
            aliasId: alias.id, brokerId, senderDomain, msgidHash, receivedAt, relayStatus: 'parse_error',
        }));
        return;
    }

    const subject = parsed.subject || '';
    const classification = classify({
        subject,
        text: parsed.text,
        html: parsed.html,
        from: (parsed.from && parsed.from.address) || fromAddr,
        contentType: message.headers.get('Content-Type') || '',
    });

    // Build the relayed copy.
    const senderName = (parsed.from && parsed.from.name) || senderDomain || 'sender';
    const cleanName = senderName.replace(/["\\\r\n]/g, '').trim() || senderDomain || 'sender';
    const aliasAddr = `${alias.slug}@${env.RELAY_DOMAIN}`;
    const fromHeader = `"${cleanName} via DataPurge" <${aliasAddr}>`;
    const replyToAddr = (parsed.from && parsed.from.address) || fromAddr;
    const relaySubject = `[DataPurge/${classification}] ${subject || '(no subject)'}`;
    const origReferences = message.headers.get('References') || parsed.references || '';
    const references = [origReferences, origMessageId].filter(Boolean).join(' ').trim() || undefined;
    const inReplyTo = origMessageId || parsed.inReplyTo || undefined;

    // Attachment budget.
    let attachments = (parsed.attachments || []).map((a) => ({
        filename: a.filename, mimeType: a.mimeType, content: toU8(a.content), disposition: a.disposition,
    }));
    const totalBytes = attachments.reduce((n, a) => n + (a.content ? a.content.byteLength : 0), 0);
    let attachStub = '';
    if (totalBytes >= MAX_ATTACH_BYTES) {
        attachments = [];
        attachStub = '\r\n\r\nNote: attachments from the original message were removed because it '
            + 'exceeded the relay size limit. Contact the sender directly if you need them.';
    }

    const footerText = `\r\n\r\n-- \r\nRelayed by DataPurge to your private alias. Classification: `
        + `${classification}. Manage, pause, or block senders at ${env.SITE_URL}/app.html`;
    const bodyText = `${parsed.text || (parsed.html ? '' : '(no text content)')}${attachStub}${footerText}`;
    const bodyHtml = parsed.html
        ? `${parsed.html}<hr><p style="color:#64748b;font-size:12px">`
            + `${attachStub ? `${escHtml(attachStub.trim())} ` : ''}`
            + `Relayed by DataPurge to your private alias. Classification: ${escHtml(classification)}. `
            + `Manage, pause, or block senders at `
            + `<a href="${env.SITE_URL}/app.html">${env.SITE_URL}/app.html</a></p>`
        : null;

    let relayed = 1;
    let relayStatus = 'relayed';
    try {
        await sendMail(env, {
            fromAddr: aliasAddr,
            fromHeader,
            to: alias.real_email,
            replyTo: replyToAddr,
            subject: relaySubject,
            references,
            inReplyTo,
            text: bodyText,
            html: bodyHtml,
            attachments,
        });
    } catch (err) {
        relayed = 0;
        relayStatus = 'send_failed';
        if (isPermanentBounce(err)) {
            relayStatus = 'permanent_bounce';
            await env.DB.prepare("UPDATE aliases SET status = 'paused' WHERE id = ? AND status = 'active'")
                .bind(alias.id).run();
        }
        // id + status only - never the error object (it can carry the address).
        console.error('relay send failed', alias.id, relayStatus);
    }

    ctx.waitUntil(persistReply(env, {
        aliasId: alias.id,
        brokerId,
        senderDomain,
        classification,
        subject,
        parsed,
        fromAddr: replyToAddr,
        receivedAt,
        msgidHash,
        relayed,
        relayStatus,
        pubkey: alias.pubkey,
        month,
        monthCount,
    }));
}

async function logMetadata(env, o) {
    await env.DB.prepare(
        `INSERT OR IGNORE INTO reply_log
         (id, alias_id, broker_id, sender_domain, classification, subject, body_sealed, msgid_hash, received_at, relayed, relay_status)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, 0, ?)`,
    ).bind(globalThis.crypto.randomUUID(), o.aliasId, o.brokerId, o.senderDomain, o.msgidHash, o.receivedAt, o.relayStatus).run();
}

async function persistReply(env, o) {
    let sealed = null;
    if (o.pubkey) {
        try {
            sealed = await seal(JSON.stringify({
                text: o.parsed.text || '',
                html: o.parsed.html || '',
                from: o.fromAddr,
                subject: o.subject,
                received_at: o.receivedAt,
            }), o.pubkey);
        } catch {
            sealed = null;
        }
    }

    await env.DB.prepare(
        `INSERT OR IGNORE INTO reply_log
         (id, alias_id, broker_id, sender_domain, classification, subject, body_sealed, msgid_hash, received_at, relayed, relay_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
        globalThis.crypto.randomUUID(), o.aliasId, o.brokerId, o.senderDomain, o.classification,
        o.subject, sealed, o.msgidHash, o.receivedAt, o.relayed, o.relayStatus,
    ).run();

    if (o.relayed) {
        await env.DB.prepare(
            'UPDATE aliases SET relay_month = ?, relay_count_month = ?, last_relay_at = ? WHERE id = ?',
        ).bind(o.month, o.monthCount + 1, o.receivedAt, o.aliasId).run();
    }

    if (o.brokerId) {
        await upsertBrokerStats(env, o.brokerId, o.classification);
    }
}

async function upsertBrokerStats(env, brokerId, classification) {
    const month = currentMonth();
    await env.DB.prepare(
        `INSERT INTO broker_stats (broker_id, month, replies, verifications, completions, form_steers, bounces)
         VALUES (?, ?, 0, 0, 0, 0, 0) ON CONFLICT(broker_id, month) DO NOTHING`,
    ).bind(brokerId, month).run();

    const col = CLASS_COUNTER[classification]; // fixed whitelist - safe to interpolate
    if (col) {
        await env.DB.prepare(
            `UPDATE broker_stats SET replies = replies + 1, ${col} = ${col} + 1 WHERE broker_id = ? AND month = ?`,
        ).bind(brokerId, month).run();
    } else {
        await env.DB.prepare(
            'UPDATE broker_stats SET replies = replies + 1 WHERE broker_id = ? AND month = ?',
        ).bind(brokerId, month).run();
    }
}

// ===================================================================
// Auth
// ===================================================================

// Authorization: Bearer {slug}.{secret}  (slug = full local part u-abc23xyz).
async function authAlias(request, env) {
    const h = request.headers.get('Authorization') || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    const token = m[1].trim();
    const dot = token.indexOf('.');
    if (dot < 0) return null;
    const slug = token.slice(0, dot);
    const secret = token.slice(dot + 1);
    if (!/^u-[a-z2-9]{8}$/.test(slug) || !secret) return null;

    const alias = await env.DB.prepare(
        "SELECT * FROM aliases WHERE slug = ? AND status IN ('active', 'paused')",
    ).bind(slug).first();
    if (!alias || !alias.secret_hash) return null;

    const provided = await sha256hex(secret);
    if (!constantTimeEqual(provided, alias.secret_hash)) return null;
    return alias;
}

// ===================================================================
// API handlers
// ===================================================================

async function handleClaim(request, env, cors) {
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON' }, 400, cors);
    }
    const email = String(body.email || '').trim();
    const pubkey = String(body.pubkey || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return jsonResponse({ error: 'A valid email address is required' }, 400, cors);
    }
    if (!pubkey) {
        return jsonResponse({ error: 'A public key is required' }, 400, cors);
    }

    const existing = await env.DB.prepare(
        "SELECT id FROM aliases WHERE real_email = ? AND status != 'deleted'",
    ).bind(email).first();
    if (existing) {
        return jsonResponse({ error: 'This email already has a reply mailbox' }, 409, cors);
    }

    let slug = makeSlug();
    for (let i = 0; i < 6; i++) {
        const clash = await env.DB.prepare('SELECT 1 FROM aliases WHERE slug = ?').bind(slug).first();
        if (!clash) break;
        slug = makeSlug();
    }

    const aliasId = globalThis.crypto.randomUUID();
    const confirmToken = globalThis.crypto.randomUUID();
    const now = new Date().toISOString();

    await env.DB.prepare(
        `INSERT INTO aliases
         (id, slug, real_email, pubkey, status, strict_mode, confirm_token, created_at, relay_month, relay_count_month)
         VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, 0)`,
    ).bind(aliasId, slug, email, pubkey, confirmToken, now, currentMonth()).run();

    const apiBase = new URL(request.url).origin;
    const confirmUrl = `${apiBase}/api/confirm?token=${confirmToken}`;

    if (env.SKIP_PAYMENT === '1') {
        await sendConfirmEmail(env, email, slug, confirmUrl);
        return jsonResponse({ status: 'pending_confirm' }, 200, cors);
    }

    // Paid path: create a Stripe Checkout subscription session.
    const params = new URLSearchParams();
    params.append('mode', 'subscription');
    params.append('line_items[0][price]', env.STRIPE_PRICE_ID);
    params.append('line_items[0][quantity]', '1');
    params.append('customer_email', email);
    params.append('client_reference_id', aliasId);
    params.append('metadata[alias_id]', aliasId);
    params.append('success_url', `${env.SITE_URL}/app.html#relay_checkout=success`);
    params.append('cancel_url', `${env.SITE_URL}/app.html#relay_checkout=cancel`);

    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params,
    });
    if (!resp.ok) {
        return jsonResponse({ error: 'Could not start checkout' }, 502, cors);
    }
    const session = await resp.json();
    return jsonResponse({ checkout_url: session.url }, 200, cors);
}

async function sendConfirmEmail(env, toEmail, slug, confirmUrl) {
    const aliasAddr = `${slug}@${env.RELAY_DOMAIN}`;
    const text = 'Confirm your DataPurge reply mailbox.\r\n\r\n'
        + `Your private alias will be:\r\n  ${aliasAddr}\r\n\r\n`
        + `Confirm to activate it:\r\n  ${confirmUrl}\r\n\r\n`
        + 'If you did not request this, ignore this email - nothing else will be sent, and the '
        + 'request is deleted automatically after 7 days.';
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head>'
        + '<body style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',system-ui,sans-serif;'
        + 'max-width:640px;margin:0 auto;padding:24px;color:#0f172a;background:#fff">'
        + '<h1 style="font-size:20px;font-weight:600;margin:0 0 12px">Confirm your DataPurge reply mailbox</h1>'
        + `<p style="color:#475569;font-size:14px">Your private alias will be <strong>${escHtml(aliasAddr)}</strong>. `
        + 'Confirm to activate it - broker replies to this address will then be relayed to your inbox.</p>'
        + `<p style="margin:24px 0"><a href="${escHtml(confirmUrl)}" style="display:inline-block;padding:10px 24px;`
        + 'background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;font-size:15px;font-weight:500">'
        + 'Confirm and activate</a></p>'
        + '<p style="color:#94a3b8;font-size:12px">If this was not you, ignore this email - nothing else will be '
        + 'sent, and the request is deleted automatically after 7 days.</p></body></html>';
    await sendMail(env, {
        fromAddr: `noreply@${env.RELAY_DOMAIN}`,
        fromHeader: `DataPurge <noreply@${env.RELAY_DOMAIN}>`,
        to: toEmail,
        subject: 'Confirm your DataPurge reply mailbox',
        text,
        html,
    });
}

async function handleStripeWebhook(request, env) {
    const raw = await request.text();
    const sig = request.headers.get('Stripe-Signature') || '';
    const ok = await verifyStripeSig(raw, sig, env.STRIPE_WEBHOOK_SECRET);
    if (!ok) return jsonResponse({ error: 'Invalid signature' }, 400);

    let event;
    try {
        event = JSON.parse(raw);
    } catch {
        return jsonResponse({ error: 'Invalid payload' }, 400);
    }

    const obj = (event.data && event.data.object) || {};

    if (event.type === 'checkout.session.completed') {
        const aliasId = (obj.metadata && obj.metadata.alias_id) || obj.client_reference_id;
        if (aliasId) {
            const alias = await env.DB.prepare('SELECT * FROM aliases WHERE id = ?').bind(aliasId).first();
            if (alias && alias.status !== 'deleted') {
                // Subscription period end if the event carries it, else now + 35
                // days. The session object does not include the subscription
                // period inline, so the fallback is the norm; the next
                // subscription webhook and the cron sweep keep it honest.
                const periodEnd = obj.subscription_details && obj.subscription_details.current_period_end;
                const paidUntil = periodEnd
                    ? new Date(periodEnd * 1000).toISOString()
                    : new Date(Date.now() + 35 * 24 * 3600 * 1000).toISOString();
                await env.DB.prepare(
                    'UPDATE aliases SET stripe_customer_id = ?, stripe_subscription_id = ?, paid_until = ? WHERE id = ?',
                ).bind(obj.customer || null, obj.subscription || null, paidUntil, alias.id).run();

                if (alias.status === 'pending' && alias.confirm_token && alias.real_email) {
                    const apiBase = new URL(request.url).origin;
                    await sendConfirmEmail(env, alias.real_email, alias.slug, `${apiBase}/api/confirm?token=${alias.confirm_token}`);
                }
            }
        }
    } else if (event.type === 'customer.subscription.deleted') {
        const subId = obj.id;
        if (subId) {
            await env.DB.prepare(
                "UPDATE aliases SET status = 'paused', paid_until = NULL WHERE stripe_subscription_id = ? AND status != 'deleted'",
            ).bind(subId).run();
        }
    }

    return jsonResponse({ received: true }, 200);
}

async function verifyStripeSig(payload, header, secret) {
    if (!secret || !header) return false;
    let t = null;
    let v1 = null;
    for (const part of header.split(',')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k === 't') t = v;
        else if (k === 'v1') v1 = v;
    }
    if (!t || !v1) return false;
    const ts = parseInt(t, 10);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
    const expected = await hmacSha256Hex(secret, `${t}.${payload}`);
    return constantTimeEqual(expected, v1);
}

async function handleConfirm(request, env) {
    const token = new URL(request.url).searchParams.get('token');
    const errUrl = `${env.SITE_URL}/app.html#relay_error=invalid_or_expired`;
    if (!token) return Response.redirect(errUrl, 302);

    const alias = await env.DB.prepare(
        "SELECT * FROM aliases WHERE confirm_token = ? AND status = 'pending'",
    ).bind(token).first();
    if (!alias) return Response.redirect(errUrl, 302);

    const secret = randomSecret();
    const secretHash = await sha256hex(secret);
    const now = new Date().toISOString();
    await env.DB.prepare(
        "UPDATE aliases SET status = 'active', secret_hash = ?, confirm_token = NULL, confirmed_at = ?, relay_month = ?, relay_count_month = 0 WHERE id = ?",
    ).bind(secretHash, now, currentMonth(), alias.id).run();

    // Secret is delivered only in the URL fragment; never logged server-side.
    const frag = `${env.SITE_URL}/app.html#relay=${alias.slug}@${env.RELAY_DOMAIN}:${secret}`;
    return Response.redirect(frag, 302);
}

async function handleReplies(request, env, alias, cors) {
    const since = new URL(request.url).searchParams.get('since') || '1970-01-01T00:00:00.000Z';
    const rows = await env.DB.prepare(
        `SELECT id, broker_id, sender_domain, classification, subject, received_at, relay_status
         FROM reply_log WHERE alias_id = ? AND received_at > ? ORDER BY received_at ASC LIMIT ?`,
    ).bind(alias.id, since, REPLIES_PAGE_MAX).all();
    return jsonResponse({ replies: rows.results }, 200, cors);
}

async function handleEvidence(env, alias, id, cors) {
    const row = await env.DB.prepare(
        'SELECT id, body_sealed, classification, sender_domain, received_at FROM reply_log WHERE id = ? AND alias_id = ?',
    ).bind(id, alias.id).first();
    if (!row) return jsonResponse({ error: 'Not found' }, 404, cors);
    return jsonResponse({
        id: row.id,
        sealed: row.body_sealed,
        classification: row.classification,
        sender_domain: row.sender_domain,
        received_at: row.received_at,
    }, 200, cors);
}

async function handleAliasGet(env, alias, cors) {
    const blocked = await env.DB.prepare(
        'SELECT sender_domain FROM blocked_senders WHERE alias_id = ?',
    ).bind(alias.id).all();
    return jsonResponse({
        alias: `${alias.slug}@${env.RELAY_DOMAIN}`,
        status: alias.status,
        strict_mode: !!alias.strict_mode,
        paid_until: alias.paid_until,
        relay_count_month: alias.relay_month === currentMonth() ? alias.relay_count_month : 0,
        blocked_domains: blocked.results.map((r) => r.sender_domain),
    }, 200, cors);
}

async function handleSettings(request, env, alias, cors) {
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON' }, 400, cors);
    }

    if (typeof body.paused === 'boolean') {
        if (alias.status === 'active' || alias.status === 'paused') {
            await env.DB.prepare('UPDATE aliases SET status = ? WHERE id = ?')
                .bind(body.paused ? 'paused' : 'active', alias.id).run();
        }
    }
    if (typeof body.strict_mode === 'boolean') {
        await env.DB.prepare('UPDATE aliases SET strict_mode = ? WHERE id = ?')
            .bind(body.strict_mode ? 1 : 0, alias.id).run();
    }
    if (body.block_domain) {
        const d = extractDomain(body.block_domain) || String(body.block_domain).toLowerCase();
        const ex = await env.DB.prepare(
            'SELECT 1 FROM blocked_senders WHERE alias_id = ? AND sender_domain = ?',
        ).bind(alias.id, d).first();
        if (!ex) {
            await env.DB.prepare('INSERT INTO blocked_senders (alias_id, sender_domain) VALUES (?, ?)')
                .bind(alias.id, d).run();
        }
    }
    if (body.unblock_domain) {
        const d = extractDomain(body.unblock_domain) || String(body.unblock_domain).toLowerCase();
        await env.DB.prepare('DELETE FROM blocked_senders WHERE alias_id = ? AND sender_domain = ?')
            .bind(alias.id, d).run();
    }
    return jsonResponse({ ok: true }, 200, cors);
}

async function handleDelete(env, alias, cors) {
    await env.DB.batch([
        env.DB.prepare('DELETE FROM reply_log WHERE alias_id = ?').bind(alias.id),
        env.DB.prepare('DELETE FROM blocked_senders WHERE alias_id = ?').bind(alias.id),
        env.DB.prepare(
            "UPDATE aliases SET real_email = NULL, pubkey = NULL, secret_hash = NULL, paid_until = NULL, confirm_token = NULL, status = 'deleted' WHERE id = ?",
        ).bind(alias.id),
    ]);
    return jsonResponse({ ok: true }, 200, cors);
}

async function handleAdminRefresh(request, env, cors) {
    const key = request.headers.get('X-Admin-Key') || '';
    if (!env.ADMIN_KEY || !constantTimeEqual(key, env.ADMIN_KEY)) {
        return jsonResponse({ error: 'Forbidden' }, 403, cors);
    }
    const count = await refreshBrokerDomains(env);
    return jsonResponse({ ok: true, domains: count }, 200, cors);
}

// ===================================================================
// Registry refresh + cron
// ===================================================================

async function refreshBrokerDomains(env) {
    const resp = await fetch(env.REGISTRY_URL, { headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`registry fetch failed: ${resp.status}`);
    const data = await resp.json();

    const pairs = new Map(); // domain -> broker_id
    for (const b of data.brokers || []) {
        if (b.domain) pairs.set(String(b.domain).toLowerCase(), b.id);
        for (const a of b.aliases || []) {
            if (a) pairs.set(String(a).toLowerCase(), b.id);
        }
    }
    // Static DSAR-vendor allowlist (NULL broker_id = known but not a broker).
    for (const d of DSAR_VENDOR_DOMAINS) {
        if (!pairs.has(d)) pairs.set(d, null);
    }

    const entries = [...pairs.entries()];
    for (let i = 0; i < entries.length; i += 50) {
        const chunk = entries.slice(i, i + 50);
        await env.DB.batch(chunk.map(([domain, brokerId]) => env.DB.prepare(
            'INSERT INTO broker_domains (domain, broker_id) VALUES (?, ?) ON CONFLICT(domain) DO UPDATE SET broker_id = excluded.broker_id',
        ).bind(domain, brokerId)));
    }
    return entries.length;
}

async function runCron(env) {
    const month = currentMonth();

    // Purge unconfirmed claims after 7 days (mirrors the drip worker).
    await env.DB.prepare(
        "DELETE FROM aliases WHERE status = 'pending' AND created_at < datetime('now', '-7 days')",
    ).run();

    // Roll the monthly relay counter.
    await env.DB.prepare(
        'UPDATE aliases SET relay_count_month = 0, relay_month = ? WHERE relay_month IS NOT ? ',
    ).bind(month, month).run();

    // Entitlement sweep: pause active aliases more than 30 days past paid_until.
    await env.DB.prepare(
        "UPDATE aliases SET status = 'paused' WHERE status = 'active' AND paid_until IS NOT NULL AND paid_until < datetime('now', '-30 days')",
    ).run();

    // Refresh the broker-domain map from the live registry.
    try {
        await refreshBrokerDomains(env);
    } catch (e) {
        console.error('broker refresh failed', e && e.name);
    }
}

// ===================================================================
// Worker entry
// ===================================================================

export default {
    async email(message, env, ctx) {
        await handleInboundEmail(message, env, ctx);
    },

    async fetch(request, env, ctx) {
        const cors = corsHeaders(env, request);
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: cors });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        try {
            if (path === '/api/claim' && request.method === 'POST') {
                return await handleClaim(request, env, cors);
            }
            if (path === '/api/stripe/webhook' && request.method === 'POST') {
                return await handleStripeWebhook(request, env);
            }
            if (path === '/api/confirm' && request.method === 'GET') {
                return await handleConfirm(request, env);
            }
            if (path === '/api/admin/refresh-domains' && request.method === 'POST') {
                return await handleAdminRefresh(request, env, cors);
            }

            // --- authenticated endpoints ---
            if (path === '/api/replies' && request.method === 'GET') {
                const alias = await authAlias(request, env);
                if (!alias) return jsonResponse({ error: 'Unauthorized' }, 401, cors);
                return await handleReplies(request, env, alias, cors);
            }
            if (path.startsWith('/api/evidence/') && request.method === 'GET') {
                const alias = await authAlias(request, env);
                if (!alias) return jsonResponse({ error: 'Unauthorized' }, 401, cors);
                const id = decodeURIComponent(path.slice('/api/evidence/'.length));
                return await handleEvidence(env, alias, id, cors);
            }
            if (path === '/api/alias' && request.method === 'GET') {
                const alias = await authAlias(request, env);
                if (!alias) return jsonResponse({ error: 'Unauthorized' }, 401, cors);
                return await handleAliasGet(env, alias, cors);
            }
            if (path === '/api/alias/settings' && request.method === 'POST') {
                const alias = await authAlias(request, env);
                if (!alias) return jsonResponse({ error: 'Unauthorized' }, 401, cors);
                return await handleSettings(request, env, alias, cors);
            }
            if (path === '/api/alias/delete' && request.method === 'POST') {
                const alias = await authAlias(request, env);
                if (!alias) return jsonResponse({ error: 'Unauthorized' }, 401, cors);
                return await handleDelete(env, alias, cors);
            }

            return jsonResponse({ error: 'Not found' }, 404, cors);
        } catch (err) {
            console.error('API error', err && err.name);
            return jsonResponse({ error: 'Internal server error' }, 500, cors);
        }
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(runCron(env));
    },
};
