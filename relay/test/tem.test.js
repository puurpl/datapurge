import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildTemPayload,
    sendViaTem,
    TEM_ATTACH_BUDGET_BYTES,
} from '../src/tem.js';
import { b64decode } from '../src/seal.js';

// Synthetic fixtures only - no real personal data, no real addresses.
const BASE = {
    fromName: 'Example Broker via DataPurge',
    fromEmail: 'u-abc23xyz@relay.example',
    to: 'user@inbox.example',
    subject: '[DataPurge/ack] Re: Data deletion request',
    text: 'We have received your request. Reference DSR-1001.',
    html: '<p>We have received your request.</p>',
    replyTo: 'privacy@examplebroker.com',
    inReplyTo: '<orig-1@examplebroker.com>',
    references: '<thread-0@examplebroker.com> <orig-1@examplebroker.com>',
};
const PROJECT_ID = 'proj-0000-1111';

// --- payload shape -------------------------------------------------

test('buildTemPayload: exact TEM body shape', () => {
    const { payload } = buildTemPayload(BASE, PROJECT_ID);
    assert.deepEqual(payload.from, {
        name: 'Example Broker via DataPurge',
        email: 'u-abc23xyz@relay.example',
    });
    assert.deepEqual(payload.to, [{ email: 'user@inbox.example' }]);
    assert.equal(payload.project_id, PROJECT_ID);
    assert.equal(payload.subject, '[DataPurge/ack] Re: Data deletion request');
    assert.ok(payload.text.startsWith('We have received your request.'));
    assert.ok(payload.html.startsWith('<p>We have received your request.</p>'));
});

test('buildTemPayload: from.name defaults to DataPurge when absent', () => {
    const { payload } = buildTemPayload({ ...BASE, fromName: undefined }, PROJECT_ID);
    assert.equal(payload.from.name, 'DataPurge');
});

test('buildTemPayload: no html key when html is absent', () => {
    const { payload } = buildTemPayload({ ...BASE, html: null }, PROJECT_ID);
    assert.equal('html' in payload, false);
});

// --- threading / reply headers ------------------------------------

test('buildTemPayload: Reply-To / In-Reply-To / References ride additional_headers', () => {
    const { payload } = buildTemPayload(BASE, PROJECT_ID);
    const map = Object.fromEntries(payload.additional_headers.map((h) => [h.key, h.value]));
    assert.equal(map['Reply-To'], 'privacy@examplebroker.com');
    assert.equal(map['In-Reply-To'], '<orig-1@examplebroker.com>');
    assert.equal(map.References, '<thread-0@examplebroker.com> <orig-1@examplebroker.com>');
});

test('buildTemPayload: header values are CRLF-collapsed (no injection)', () => {
    const { payload } = buildTemPayload(
        { ...BASE, replyTo: 'a@x.example\r\nBcc: victim@y.example' },
        PROJECT_ID,
    );
    const map = Object.fromEntries(payload.additional_headers.map((h) => [h.key, h.value]));
    assert.equal(/[\r\n]/.test(map['Reply-To']), false);
    assert.ok(map['Reply-To'].includes('a@x.example'));
});

test('buildTemPayload: no additional_headers key when none supplied', () => {
    const { payload } = buildTemPayload(
        { fromName: 'DataPurge', fromEmail: 'noreply@relay.example', to: 't@x.example', subject: 'Hi there friend', text: 'Confirm your mailbox now please.' },
        PROJECT_ID,
    );
    assert.equal('additional_headers' in payload, false);
});

// --- attachments: whitelist + base64 ------------------------------

test('buildTemPayload: whitelisted attachment is base64-encoded correctly', () => {
    const raw = new TextEncoder().encode('%PDF-1.4 fake pdf bytes');
    const { payload, stripped } = buildTemPayload(
        { ...BASE, attachments: [{ filename: 'proof.pdf', mimeType: 'application/pdf', content: raw }] },
        PROJECT_ID,
    );
    assert.equal(payload.attachments.length, 1);
    const att = payload.attachments[0];
    assert.equal(att.name, 'proof.pdf');
    assert.equal(att.type, 'application/pdf');
    assert.deepEqual(b64decode(att.content), raw);
    assert.deepEqual(stripped, { dropped: [], sizeStripped: false });
});

test('buildTemPayload: content-type parameters are ignored for the whitelist', () => {
    const raw = new TextEncoder().encode('hello,world');
    const { payload } = buildTemPayload(
        { ...BASE, attachments: [{ filename: 'a.csv', mimeType: 'text/csv; charset=utf-8', content: raw }] },
        PROJECT_ID,
    );
    assert.equal(payload.attachments.length, 1);
    assert.equal(payload.attachments[0].type, 'text/csv');
});

// --- attachments: MIME filter -------------------------------------

test('buildTemPayload: non-whitelisted attachment is dropped with a stub line', () => {
    const raw = new TextEncoder().encode('PK fake zip');
    const { payload, stripped } = buildTemPayload(
        { ...BASE, attachments: [{ filename: 'archive.zip', mimeType: 'application/zip', content: raw }] },
        PROJECT_ID,
    );
    assert.equal('attachments' in payload, false);
    assert.deepEqual(stripped, { dropped: ['archive.zip'], sizeStripped: false });
    assert.ok(payload.text.includes('archive.zip'));
    assert.ok(/file type is not\s+accepted/.test(payload.text));
    assert.ok(payload.html.includes('archive.zip'));
});

test('buildTemPayload: keeps whitelisted, drops non-whitelisted, in one message', () => {
    const good = new TextEncoder().encode('good');
    const bad = new TextEncoder().encode('bad');
    const { payload, stripped } = buildTemPayload(
        {
            ...BASE,
            attachments: [
                { filename: 'ok.pdf', mimeType: 'application/pdf', content: good },
                { filename: 'bad.exe', mimeType: 'application/octet-stream', content: bad },
            ],
        },
        PROJECT_ID,
    );
    assert.equal(payload.attachments.length, 1);
    assert.equal(payload.attachments[0].name, 'ok.pdf');
    assert.deepEqual(stripped.dropped, ['bad.exe']);
});

// --- attachments: 2 MB budget strip -------------------------------

test('buildTemPayload: over-budget attachments are all stripped with the size stub', () => {
    // Encoded size = 4/3 * raw. Pick raw so the encoded total exceeds the budget.
    const rawLen = Math.ceil((TEM_ATTACH_BUDGET_BYTES * 3) / 4) + 4096;
    const big = new Uint8Array(rawLen); // whitelisted type, but too large once encoded
    const { payload, stripped } = buildTemPayload(
        { ...BASE, attachments: [{ filename: 'huge.pdf', mimeType: 'application/pdf', content: big }] },
        PROJECT_ID,
    );
    assert.equal('attachments' in payload, false);
    assert.equal(stripped.sizeStripped, true);
    assert.ok(payload.text.includes('exceeded the relay size limit'));
});

test('buildTemPayload: attachments just under budget survive', () => {
    const rawLen = Math.floor((TEM_ATTACH_BUDGET_BYTES * 3) / 4) - 4096;
    const big = new Uint8Array(rawLen);
    const { payload, stripped } = buildTemPayload(
        { ...BASE, attachments: [{ filename: 'ok.pdf', mimeType: 'application/pdf', content: big }] },
        PROJECT_ID,
    );
    assert.equal(payload.attachments.length, 1);
    assert.equal(stripped.sizeStripped, false);
});

// --- sendViaTem (mocked fetch) ------------------------------------

function mockFetch(status, jsonBody) {
    const calls = [];
    const impl = async (url, opts) => {
        calls.push({ url, opts });
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => jsonBody,
        };
    };
    impl.calls = calls;
    return impl;
}

const ENV = { SCW_SECRET_KEY: 'scw-secret', SCW_PROJECT_ID: PROJECT_ID, TEM_REGION: 'fr-par' };

test('sendViaTem: posts to the fr-par region URL with X-Auth-Token', async () => {
    const impl = mockFetch(200, { emails: [{ id: 'msg-123', status: 'new' }] });
    const res = await sendViaTem(ENV, BASE, impl);
    assert.equal(res.temEmailId, 'msg-123');

    assert.equal(impl.calls.length, 1);
    const { url, opts } = impl.calls[0];
    assert.equal(url, 'https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers['X-Auth-Token'], 'scw-secret');
    assert.equal(opts.headers['Content-Type'], 'application/json');
    const sent = JSON.parse(opts.body);
    assert.equal(sent.project_id, PROJECT_ID);
    assert.equal(sent.to[0].email, 'user@inbox.example');
});

test('sendViaTem: region falls back to fr-par when unset', async () => {
    const impl = mockFetch(200, { emails: [{ id: 'msg-9' }] });
    await sendViaTem({ SCW_SECRET_KEY: 'k', SCW_PROJECT_ID: PROJECT_ID }, BASE, impl);
    assert.ok(impl.calls[0].url.includes('/regions/fr-par/emails'));
});

test('sendViaTem: throws on a non-2xx, with status only (no address)', async () => {
    const impl = mockFetch(500, { error: 'boom' });
    await assert.rejects(
        () => sendViaTem(ENV, BASE, impl),
        (err) => {
            assert.ok(/status 500/.test(err.message));
            assert.equal(err.message.includes('user@inbox.example'), false);
            assert.equal(err.message.includes('examplebroker'), false);
            return true;
        },
    );
});

test('sendViaTem: returns null id when the response carries no emails', async () => {
    const impl = mockFetch(200, {});
    const res = await sendViaTem(ENV, BASE, impl);
    assert.equal(res.temEmailId, null);
});
