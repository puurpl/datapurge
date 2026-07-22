import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTemNotification, decideTemAction } from '../src/tem.js';

// --- parseTemNotification -----------------------------------------

test('parseTemNotification: SubscriptionConfirmation exposes the SubscribeURL', () => {
    const note = parseTemNotification({
        Type: 'SubscriptionConfirmation',
        SubscribeURL: 'https://sns.mnq.fr-par.scaleway.com/confirm?token=abc',
        TopicArn: 'arn:scw:mnq:fr-par:project:topic/relay',
        Token: 'abc',
    });
    assert.equal(note.kind, 'subscription_confirmation');
    assert.equal(note.subscribeUrl, 'https://sns.mnq.fr-par.scaleway.com/confirm?token=abc');
    assert.equal(note.topicArn, 'arn:scw:mnq:fr-par:project:topic/relay');
});

test('parseTemNotification: Notification JSON-parses the Message field', () => {
    const event = { type: 'email_delivered', email_id: 'msg-1' };
    const note = parseTemNotification({
        Type: 'Notification',
        Message: JSON.stringify(event),
        TopicArn: 'arn:scw:...',
    });
    assert.equal(note.kind, 'notification');
    assert.deepEqual(note.event, event);
});

test('parseTemNotification: tolerates an already-object Message', () => {
    const note = parseTemNotification({
        Type: 'Notification',
        Message: { type: 'email_dropped', email_id: 'msg-2' },
    });
    assert.equal(note.kind, 'notification');
    assert.equal(note.event.email_id, 'msg-2');
});

test('parseTemNotification: malformed Message yields a null event', () => {
    const note = parseTemNotification({ Type: 'Notification', Message: '{not json' });
    assert.equal(note.kind, 'notification');
    assert.equal(note.event, null);
});

test('parseTemNotification: unknown / empty bodies are classified unknown', () => {
    assert.equal(parseTemNotification({ Type: 'Whatever' }).kind, 'unknown');
    assert.equal(parseTemNotification({}).kind, 'unknown');
    assert.equal(parseTemNotification(null).kind, 'unknown');
});

// --- decideTemAction mapping table --------------------------------

const CASES = [
    ['email_delivered', 'mark', 'delivered'],
    ['delivered', 'mark', 'delivered'],
    ['email_deferred', 'mark', 'deferred'],
    ['email_spam', 'mark', 'spam_flagged'],
    ['email_dropped', 'bounce', undefined],
    ['email_mailbox_not_found', 'bounce', undefined],
    ['email_blocklisted', 'blocklist', undefined],
    ['blocklist_created', 'blocklist', undefined],
    ['email_queued', 'ignore', undefined],
    ['something_else', 'ignore', undefined],
];

for (const [type, kind, status] of CASES) {
    test(`decideTemAction: ${type} -> ${kind}${status ? `/${status}` : ''}`, () => {
        const action = decideTemAction({ type, email_id: 'msg-x', email_to: 'user@inbox.example' });
        assert.equal(action.kind, kind);
        assert.equal(action.status, status);
    });
}

test('decideTemAction: mark carries the email id for the reply_log lookup', () => {
    const action = decideTemAction({ type: 'email_delivered', email_id: 'msg-42' });
    assert.equal(action.kind, 'mark');
    assert.equal(action.emailId, 'msg-42');
});

test('decideTemAction: bounce carries the email id', () => {
    const action = decideTemAction({ event_type: 'email_dropped', email_id: 'msg-7' });
    assert.equal(action.kind, 'bounce');
    assert.equal(action.emailId, 'msg-7');
});

test('decideTemAction: blocklist carries the recipient address', () => {
    const action = decideTemAction({ type: 'blocklist_created', email: 'user@inbox.example' });
    assert.equal(action.kind, 'blocklist');
    assert.equal(action.email, 'user@inbox.example');
});

test('decideTemAction: reads id/recipient from a nested email object', () => {
    const action = decideTemAction({
        type: 'email_delivered',
        email: { id: 'msg-nested', rcpt_to: 'user@inbox.example' },
    });
    assert.equal(action.emailId, 'msg-nested');
    assert.equal(action.email, 'user@inbox.example');
});

test('decideTemAction: non-object input is ignored', () => {
    assert.equal(decideTemAction(null).kind, 'ignore');
    assert.equal(decideTemAction('nope').kind, 'ignore');
    assert.equal(decideTemAction({}).kind, 'ignore');
});

// --- index.js import smoke ----------------------------------------
// With the cloudflare:email import gone, index.js should load under plain node.
// It still imports postal-mime (an npm dep); if that is not installed in this
// environment the import cannot resolve, so we skip rather than fail.

test('index.js imports under plain node (no cloudflare:email)', async (t) => {
    let mod;
    try {
        mod = await import('../src/index.js');
    } catch (err) {
        t.skip(`index import unavailable in this environment: ${err.code || err.message}`);
        return;
    }
    assert.equal(typeof mod.default.email, 'function');
    assert.equal(typeof mod.default.fetch, 'function');
    assert.equal(typeof mod.default.scheduled, 'function');
});
