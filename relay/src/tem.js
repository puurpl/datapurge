/**
 * DataPurge Reply Mailbox - Scaleway Transactional Email (TEM) client.
 *
 * PURE and node-testable: no Workers-only imports, no network at module load.
 * The only send path in the relay goes through here. We NEVER email brokers -
 * TEM only ever carries the relayed copy to the user's own inbox and the
 * double-opt-in confirmation mail.
 *
 * TEM facts baked in here:
 *   - POST https://api.scaleway.com/transactional-email/v1alpha1/regions/{region}/emails
 *   - auth header X-Auth-Token = IAM secret key; project_id lives in the body
 *   - body fields: from{name,email}, to[{email}], subject, text, html,
 *     attachments[{name,type,content=base64}], additional_headers[{key,value}]
 *   - a 2xx response means QUEUED only; every delivery outcome arrives later
 *     over the webhook (see parseTemNotification / decideTemAction)
 *   - 2MB total API limit, MIME whitelist (zip is Scale-plan only, excluded here)
 *
 * Never put an address, subject, or body into a thrown message or a log line -
 * status codes and ids only.
 */

import { b64encode } from './seal.js';

const ENC = new TextEncoder();

// Scaleway TEM total request budget is 2 MB. Base64 inflates raw bytes by 4/3,
// so we cap the *encoded* attachment total at ~1.8 MB and leave the balance for
// the JSON envelope, headers, and message body.
export const TEM_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const TEM_ATTACH_BUDGET_BYTES = Math.floor(1.8 * 1024 * 1024);

// Attachment MIME whitelist. Mirrors Scaleway TEM's accepted content types on
// the PAYG plan. application/zip is DELIBERATELY excluded - it is accepted only
// on the Scale plan, so a zip would 400 the whole send; we drop it with a stub.
export const TEM_ALLOWED_MIME = new Set([
    'application/pdf',
    'application/rtf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/bmp',
    'image/tiff',
    'image/webp',
    'text/plain',
    'text/csv',
    'text/html',
    'text/calendar',
    'text/xml',
    'application/xml',
]);

// ===================================================================
// Small pure helpers
// ===================================================================

function toBytes(content) {
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

function normMime(t) {
    return String(t || 'application/octet-stream').toLowerCase().split(';')[0].trim();
}

// Collapse CR/LF so a value taken from an inbound header can never inject a new
// header line once TEM assembles the outgoing MIME.
function headerValue(v) {
    return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ===================================================================
// Payload builder + attachment policy
// ===================================================================

/**
 * Build the exact TEM request body from a send request.
 *
 * opts: { fromName, fromEmail, to, subject, text, html, replyTo, inReplyTo,
 *         references, attachments:[{filename, mimeType, content}] }
 *
 * Attachment policy (replaces the old flat 4 MB rule):
 *   1. Drop any attachment whose MIME type is not on the TEM whitelist, adding
 *      one stub line to the body per dropped file.
 *   2. If the surviving attachments still exceed the encoded budget, strip them
 *      ALL and add the size-limit stub line.
 *
 * Returns { payload, stripped } where stripped = { dropped:[names], sizeStripped }.
 */
export function buildTemPayload(opts, projectId) {
    const o = opts || {};

    const additionalHeaders = [];
    if (o.replyTo) additionalHeaders.push({ key: 'Reply-To', value: headerValue(o.replyTo) });
    if (o.inReplyTo) additionalHeaders.push({ key: 'In-Reply-To', value: headerValue(o.inReplyTo) });
    if (o.references) additionalHeaders.push({ key: 'References', value: headerValue(o.references) });

    // Whitelist filter.
    const dropped = [];
    let kept = [];
    for (const a of (o.attachments || []).filter(Boolean)) {
        const name = a.filename || a.name || 'attachment';
        const type = normMime(a.mimeType || a.type);
        if (!TEM_ALLOWED_MIME.has(type)) {
            dropped.push(name);
            continue;
        }
        kept.push({ name, type, content: b64encode(toBytes(a.content)) });
    }

    // Encoded-size budget: strip all-or-nothing so a partial set never misleads.
    let sizeStripped = false;
    const encodedTotal = kept.reduce((n, a) => n + a.content.length, 0);
    if (encodedTotal > TEM_ATTACH_BUDGET_BYTES) {
        kept = [];
        sizeStripped = true;
    }

    // Body stubs for anything we could not carry.
    const notes = [];
    for (const name of dropped) {
        notes.push(`Note: an attachment (${name}) was removed because its file type is not `
            + 'accepted by the mail service. Contact the sender directly if you need it.');
    }
    if (sizeStripped) {
        notes.push('Note: attachments from the original message were removed because it exceeded '
            + 'the relay size limit. Contact the sender directly if you need them.');
    }

    let text = String(o.text == null ? '' : o.text);
    let html = (o.html == null) ? null : String(o.html);
    if (notes.length) {
        text += `\r\n\r\n${notes.join('\r\n')}`;
        if (html != null) {
            html += '<hr><p style="color:#64748b;font-size:12px">'
                + `${notes.map(escapeHtml).join('<br>')}</p>`;
        }
    }

    const payload = {
        from: { name: o.fromName || 'DataPurge', email: o.fromEmail },
        to: [{ email: o.to }],
        project_id: projectId,
        subject: String(o.subject == null ? '' : o.subject),
        text,
    };
    if (html != null) payload.html = html;
    if (additionalHeaders.length) payload.additional_headers = additionalHeaders;
    if (kept.length) {
        payload.attachments = kept.map((a) => ({ name: a.name, type: a.type, content: a.content }));
    }

    return { payload, stripped: { dropped, sizeStripped } };
}

// ===================================================================
// Send
// ===================================================================

/**
 * POST a message to Scaleway TEM. A 2xx means QUEUED (status "new"); the real
 * outcome comes back on the webhook. Returns { temEmailId } on success; throws
 * on any non-2xx with the status code ONLY (never an address) in the message.
 *
 * fetchImpl is injectable so the send path is testable without a network.
 */
export async function sendViaTem(env, opts, fetchImpl = fetch) {
    const region = (env && env.TEM_REGION) || 'fr-par';
    const { payload } = buildTemPayload(opts, env && env.SCW_PROJECT_ID);
    const url = `https://api.scaleway.com/transactional-email/v1alpha1/regions/${region}/emails`;

    const resp = await fetchImpl(url, {
        method: 'POST',
        headers: {
            'X-Auth-Token': (env && env.SCW_SECRET_KEY) || '',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });

    if (!resp || !resp.ok) {
        const status = resp ? resp.status : 0;
        throw new Error(`TEM send failed with status ${status}`);
    }

    let json = {};
    try {
        json = await resp.json();
    } catch {
        json = {};
    }
    const temEmailId = (json && json.emails && json.emails[0] && json.emails[0].id) || null;
    return { temEmailId };
}

// ===================================================================
// Webhook parsing (Scaleway Topics-and-Events, SNS-compatible)
// ===================================================================

/**
 * Classify an incoming webhook POST body.
 *
 * SubscriptionConfirmation -> { kind:'subscription_confirmation', subscribeUrl, topicArn }
 * Notification             -> { kind:'notification', event, topicArn }  (Message JSON-parsed)
 * anything else            -> { kind:'unknown' }
 */
export function parseTemNotification(bodyJson) {
    const b = bodyJson || {};
    const type = b.Type || b.type;

    if (type === 'SubscriptionConfirmation') {
        return {
            kind: 'subscription_confirmation',
            subscribeUrl: b.SubscribeURL || b.SubscribeUrl || null,
            topicArn: b.TopicArn || null,
        };
    }
    if (type === 'Notification') {
        let event = null;
        const raw = b.Message;
        if (raw && typeof raw === 'object') {
            event = raw;
        } else if (typeof raw === 'string') {
            try {
                event = JSON.parse(raw);
            } catch {
                event = null;
            }
        }
        return { kind: 'notification', event, topicArn: b.TopicArn || null };
    }
    return { kind: 'unknown' };
}

// TEM event name -> what the relay should do. Names are normalized (an "email_"
// prefix is stripped) before lookup.
const TEM_EVENT_ACTIONS = {
    delivered: { kind: 'mark', status: 'delivered' },
    deferred: { kind: 'mark', status: 'deferred' },
    spam: { kind: 'mark', status: 'spam_flagged' },
    dropped: { kind: 'bounce' },
    mailbox_not_found: { kind: 'bounce' },
    blocklisted: { kind: 'blocklist' },
    blocklist_created: { kind: 'blocklist' },
    queued: { kind: 'ignore' },
    new: { kind: 'ignore' },
};

/**
 * Map a parsed TEM event to a relay action.
 *
 * delivered / deferred / spam   -> { kind:'mark', status, emailId }
 * dropped / mailbox_not_found   -> { kind:'bounce', emailId }
 * blocklisted / blocklist_created -> { kind:'blocklist', email }
 * everything else               -> { kind:'ignore' }
 */
export function decideTemAction(event) {
    if (!event || typeof event !== 'object') return { kind: 'ignore' };

    let name = String(event.type || event.event_type || event.event || '').toLowerCase().trim();
    if (name.startsWith('email_')) name = name.slice('email_'.length);

    const base = TEM_EVENT_ACTIONS[name] || { kind: 'ignore' };

    const emailObj = (event.email && typeof event.email === 'object') ? event.email : null;
    const emailId = event.email_id || (emailObj && emailObj.id) || null;
    const recipient = event.email_to
        || event.to
        || event.rcpt_to
        || (emailObj && (emailObj.rcpt_to || emailObj.to || emailObj.email))
        || (typeof event.email === 'string' ? event.email : null)
        || null;

    return { ...base, emailId, email: recipient };
}
