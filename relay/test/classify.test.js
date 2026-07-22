import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, extractDomain, DSAR_VENDOR_DOMAINS } from '../src/classify.js';

// Sanitized, .eml-ish fixtures. Phrasing mirrors realistic broker replies.
// NO real personal data - synthetic names/addresses/domains only.

const FIXTURES = {
    ack: {
        from: 'privacy@examplebroker.com',
        subject: 'Re: Data deletion request',
        text: 'Hello,\n\nWe have received your request and it has been logged under '
            + 'reference number DSR-48211. Our team will respond within 45 days as '
            + 'required by law.\n\nRegards,\nPrivacy Team',
        html: '',
        contentType: 'text/plain; charset=UTF-8',
        expect: 'ack',
    },
    verification_onetrust: {
        from: 'DSAR Portal <noreply@my.onetrust.com>',
        subject: 'Action required: verify your request',
        text: 'You recently submitted a data subject request. To verify your identity, '
            + 'please click the link below to confirm your email address before we can '
            + 'proceed with your request.\n\nRequest ID: 7781-AA',
        html: '<p>To verify your identity, please <a href="https://my.onetrust.com/v/abc">'
            + 'click the link below to confirm</a> your email address.</p>',
        contentType: 'multipart/alternative; boundary=x',
        expect: 'verification_required',
    },
    verification_plain: {
        from: 'support@examplebroker.com',
        subject: 'Please confirm your identity',
        text: 'Before we can process your deletion request we need to verify your '
            + 'identity. Please reply to this email to confirm you submitted this request, '
            + 'and provide a copy of your government photo ID.',
        html: '',
        contentType: 'text/plain',
        expect: 'verification_required',
    },
    verification_dsar_fallback: {
        // No explicit verify/form keywords, but from a DSAR-vendor workflow domain.
        from: 'workflow@transcend.io',
        subject: 'Your privacy request has an update',
        text: 'There is an update on your privacy request. Please sign in to the portal '
            + 'to see the next step.',
        html: '',
        contentType: 'text/plain',
        expect: 'verification_required',
    },
    completed: {
        from: 'privacy@examplebroker.com',
        subject: 'Re: Your deletion request',
        text: 'Your personal information has been deleted from our systems and we no '
            + 'longer retain any records associated with you. This request is now '
            + 'complete.',
        html: '',
        contentType: 'text/plain',
        expect: 'completed',
    },
    rejected_use_form: {
        from: 'privacy@examplebroker.com',
        subject: 'Re: Data request',
        text: 'We do not accept deletion requests via email. Please visit our privacy '
            + 'portal and complete the form located at https://examplebroker.com/privacy '
            + 'to submit your request.',
        html: '',
        contentType: 'text/plain',
        expect: 'rejected_use_form',
    },
    bounce_ndr: {
        from: 'Mail Delivery Subsystem <MAILER-DAEMON@mail.examplebroker.com>',
        subject: 'Undeliverable: Data deletion request',
        text: 'The following message to <privacy@examplebroker.com> could not be '
            + 'delivered.\n\n550 5.1.1 recipient address rejected: user unknown',
        html: '',
        contentType: 'multipart/report; report-type=delivery-status; boundary=y',
        expect: 'bounce_ndr',
    },
    bounce_by_code: {
        // NDR detected by delivery code in the body even without a daemon From.
        from: 'postmaster@examplebroker.com',
        subject: 'Returned mail',
        text: 'Your message was not delivered. 5.1.1 mailbox unavailable.',
        html: '',
        contentType: 'text/plain',
        expect: 'bounce_ndr',
    },
    unrelated_marketing: {
        from: 'deals@examplebroker.com',
        subject: 'Summer sale - 50% off all premium plans!',
        text: 'Upgrade today and save big on our premium data plans. Limited time offer, '
            + 'do not miss out on these exclusive savings.',
        html: '',
        contentType: 'text/plain',
        expect: 'unrelated',
    },
    unrelated_empty: {
        from: 'someone@examplebroker.com',
        subject: '',
        text: '',
        html: '',
        contentType: '',
        expect: 'unrelated',
    },
};

for (const [name, fx] of Object.entries(FIXTURES)) {
    test(`classify: ${name} -> ${fx.expect}`, () => {
        const got = classify({
            subject: fx.subject,
            text: fx.text,
            html: fx.html,
            from: fx.from,
            contentType: fx.contentType,
        });
        assert.equal(got, fx.expect, `expected ${fx.expect} for fixture "${name}", got ${got}`);
    });
}

test('classify: form-steer beats verification when both present', () => {
    const got = classify({
        subject: 'Re: request',
        text: 'To verify your identity, complete the form located at https://x.example/form',
        from: 'privacy@examplebroker.com',
        contentType: 'text/plain',
    });
    assert.equal(got, 'rejected_use_form');
});

test('classify: NDR content-type wins even with request language', () => {
    const got = classify({
        subject: 'Delivery Status Notification',
        text: 'We have received your request', // ack-ish phrasing
        from: 'privacy@examplebroker.com',
        contentType: 'multipart/report; report-type=delivery-status',
    });
    assert.equal(got, 'bounce_ndr');
});

test('classify: returns a valid label for empty input', () => {
    const labels = new Set([
        'ack', 'verification_required', 'completed',
        'rejected_use_form', 'bounce_ndr', 'unrelated',
    ]);
    assert.ok(labels.has(classify()));
    assert.ok(labels.has(classify({})));
});

// --- extractDomain edge cases ---

const DOMAIN_CASES = [
    ['privacy@examplebroker.com', 'examplebroker.com'],
    ['noreply@news.examplebroker.com', 'examplebroker.com'],
    ['Foo Bar <agent@sub.example.co.uk>', 'example.co.uk'],
    ['user@company.com.au', 'company.com.au'],
    ['x@securiti.ai', 'securiti.ai'],
    ['x@my.onetrust.com', 'onetrust.com'],
    ['examplebroker.com', 'examplebroker.com'],
    ['deep.a.b.example.com', 'example.com'],
    ['', ''],
];

for (const [input, expected] of DOMAIN_CASES) {
    test(`extractDomain(${JSON.stringify(input)}) -> ${expected}`, () => {
        assert.equal(extractDomain(input), expected);
    });
}

test('DSAR_VENDOR_DOMAINS contains the expected vendors', () => {
    for (const d of ['onetrust.com', 'ketch.com', 'transcend.io', 'securiti.ai',
        'truyo.com', 'wirewheel.io', 'mydatarequest.com', 'datagrail.io', 'my.onetrust.com']) {
        assert.ok(DSAR_VENDOR_DOMAINS.includes(d), `missing ${d}`);
    }
});

test('completion notice with "information" after "completed" is not a form steer', () => {
    const verdict = classify({
        subject: 'Your request has been completed',
        text: 'Your personal information has been deleted from our systems. This confirms your request is complete.',
        html: '',
        from: 'privacy@example.com',
        contentType: 'text/plain',
    });
    assert.equal(verdict, 'completed');
});
