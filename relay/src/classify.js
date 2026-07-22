/**
 * DataPurge Reply Mailbox - reply classifier.
 *
 * PURE, dependency-free ES module. It never touches the network, the DB, or any
 * Worker binding, so the test suite imports it directly under plain `node`.
 *
 * classify({subject, text, html, from, contentType}) returns exactly one of:
 *   ack | verification_required | completed | rejected_use_form | bounce_ndr | unrelated
 *
 * Rules are applied in a fixed order (per the design plan):
 *   1. bounce_ndr        - mailer-daemon / postmaster / multipart-report / delivery codes
 *   2. rejected_use_form - "use our web form", privacy portal, "complete the form"
 *   3. verification_required - identity/email verification, DSAR-vendor loops
 *   4. completed         - data deleted / request fulfilled
 *   5. ack               - "we have received your request", reference numbers
 *   6. unrelated         - everything else (marketing, off-topic)
 */

// DSAR / consent-management vendors that broker request workflows run through.
// Mail from these domains is almost always a verification / action-required step.
export const DSAR_VENDOR_DOMAINS = [
    'onetrust.com',
    'my.onetrust.com',
    'ketch.com',
    'transcend.io',
    'securiti.ai',
    'truyo.com',
    'wirewheel.io',
    'mydatarequest.com',
    'datagrail.io',
];

// Small hardcoded list of common two-part public suffixes so extractDomain can
// approximate eTLD+1 without shipping the full Public Suffix List.
const TWO_PART_TLDS = new Set([
    'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk',
    'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
    'co.nz', 'net.nz', 'org.nz',
    'co.jp', 'or.jp', 'ne.jp', 'go.jp',
    'co.za', 'org.za',
    'com.br', 'com.mx', 'com.sg', 'com.hk', 'com.tr', 'com.cn',
    'co.in', 'co.kr', 'co.il',
]);

/**
 * Approximate eTLD+1 for an email address or bare domain.
 * "Foo <a@sub.example.co.uk>" -> "example.co.uk"; "x@mail.example.com" -> "example.com".
 */
export function extractDomain(addr) {
    if (!addr) return '';
    let s = String(addr).trim().toLowerCase();
    const angle = s.match(/<([^>]+)>/);
    if (angle) s = angle[1];
    if (s.includes('@')) s = s.split('@').pop();
    s = s.replace(/[>\s]/g, '').replace(/\.+$/, '');
    const labels = s.split('.').filter(Boolean);
    if (labels.length <= 2) return labels.join('.');
    const lastTwo = labels.slice(-2).join('.');
    if (TWO_PART_TLDS.has(lastTwo)) return labels.slice(-3).join('.');
    return lastTwo;
}

function stripHtml(html) {
    return String(html || '')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');
}

function anyMatch(hay, patterns) {
    return patterns.some((re) => re.test(hay));
}

// --- Ordered rule sets ---

const NDR_FROM = /(mailer-daemon|postmaster|mail delivery (subsystem|system)|delivery subsystem)/i;
const NDR_SUBJECT = /(undeliverable|delivery status notification|delivery (has )?failed|delivery failure|returned mail|mail delivery failed|failure notice|message not delivered|could not be delivered|returned to sender)/i;
const NDR_BODY = /(\b550[ -]|\b5\.\d\.\d\b|recipient address rejected|mailbox (is )?(unavailable|full)|user unknown|no such user|address (not found|rejected)|does not have an? account)/i;

const FORM_STEER = [
    /complete the (online )?form/i,
    /\b(web ?form|online form)\b/i,
    /(submit|make|file|log|logged)[^.]{0,40}(request|opt.?out)[^.]{0,40}(through|via|using|at|on)[^.]{0,25}(\bform\b|portal|website|web site|online|page)/i,
    /privacy (portal|request center|request centre|request portal|request page)/i,
    /\brequest (center|centre|portal)\b/i,
    /(fill (out|in)|complete)[^.]{0,25}(the )?\b(form|webform)\b/i,
    /(do not|don't|cannot|can't|unable to|won't|are unable to)[^.]{0,40}(accept|process)[^.]{0,40}(e-?mail|via e-?mail)/i,
    /must be (submitted|made|completed)[^.]{0,25}(through|via|using|on)[^.]{0,25}(our|the)[^.]{0,25}(\bform\b|portal|website|web site)/i,
    /(located|found|available) at (https?:|www\.)/i,
    /use our (web ?form|online form|portal|form|request form)/i,
];

const VERIFICATION = [
    /verify (your )?(identity|email|e-mail|request|account|information)/i,
    /identity (verification|confirmation|check)/i,
    /confirm (your )?(identity|email|e-mail|request|the request|that you)/i,
    /(to )?verify (that )?(it['’]?s|you are|you're) you/i,
    /click (the|this|below|on the)[^.]{0,25}(link|button)[^.]{0,25}(to )?(verify|confirm)/i,
    /(verify|confirm)[^.]{0,25}(before we (can|will)|to (proceed|continue|process|complete))/i,
    /we (need|require|will need|are unable)[^.]{0,45}(verify|confirm|additional information|more information)/i,
    /(additional|further|more) (information|details|documentation)[^.]{0,25}(to (verify|confirm|process|locate)|is (needed|required)|are (needed|required))/i,
    /verification (link|code|required|step|is required)/i,
    /(proof|copy) of (your )?(identity|id|government|photo id)/i,
    /reply[^.]{0,20}(to )?(this (email|message))[^.]{0,25}(to )?(confirm|verify)/i,
    /please confirm[^.]{0,35}(request|you (submitted|made|wish|want|would))/i,
];

const COMPLETED = [
    /(request|opt.?out|deletion|removal)[^.]{0,35}(has been|have been|is|was|been)[^.]{0,20}(completed|fulfilled|processed|honou?red|actioned)/i,
    /(has been|is now|is|are now) (complete|completed)\b/i,
    /(we have|we've|have)[^.]{0,25}(deleted|removed|erased|purged|expunged)[^.]{0,35}(your|the|all)[^.]{0,25}(information|data|personal|records|record|details|account|profile)/i,
    /your ([a-z ]{0,30})?(information|data|personal information|records|record|details|account|profile)[^.]{0,25}(has|have) been (deleted|removed|erased|purged)/i,
    /(successfully|now)[^.]{0,12}(deleted|removed|processed|completed|erased)/i,
    /no longer (have|retain|hold|store|keep|process)[^.]{0,25}(your|any)/i,
    /(we have|we've) removed you (from|from our)/i,
    /opt.?out[^.]{0,20}(is |has been )?(complete|completed|processed|honou?red|confirmed)/i,
];

const ACK = [
    /(we have|we've|have) received your (request|email|e-mail|message|inquiry|enquiry|submission)/i,
    /your (request|email|e-mail|message|submission)[^.]{0,25}(has been|was|is) received/i,
    /thank you for (contacting|your (request|email|e-mail|message|inquiry|enquiry|submission)|reaching out|getting in touch|submitting)/i,
    /we (are|will be|have begun|are now)[^.]{0,25}(processing|reviewing|working on|looking into|handling)[^.]{0,25}(your )?(request|inquiry|enquiry)/i,
    /(reference|case|ticket|request|confirmation)[^.]{0,12}(number|no\.?|#|id\b|id:)/i,
    /we will (respond|reply|get back|process|process your request)[^.]{0,35}(within|in|by)/i,
    /(this|your) (request|case|ticket) (has been|is) (logged|created|opened|registered|assigned)/i,
    /acknowledge[^.]{0,20}(receipt|your (request|email|message))/i,
];

/**
 * Classify a broker reply. Every argument is optional; missing fields are
 * treated as empty. Returns one of the six fixed labels.
 */
export function classify({ subject, text, html, from, contentType } = {}) {
    const subj = String(subject || '').toLowerCase();
    const fromStr = String(from || '');
    const ct = String(contentType || '').toLowerCase();
    const bodyHay = [String(text || ''), stripHtml(html)].join('\n').toLowerCase();
    const hay = [subj, bodyHay].join('\n');

    // 1. Non-delivery reports first.
    const ctReport = /multipart\/report|report-type=[^;]*delivery-status|message\/delivery-status/.test(ct);
    if (ctReport || NDR_FROM.test(fromStr) || NDR_SUBJECT.test(subj) || NDR_BODY.test(bodyHay)) {
        return 'bounce_ndr';
    }

    // 2. "Use our web form" steers.
    if (anyMatch(hay, FORM_STEER)) return 'rejected_use_form';

    // 3. Identity / email verification loops.
    if (anyMatch(hay, VERIFICATION)) return 'verification_required';

    // 4. Completion / deletion confirmations.
    if (anyMatch(hay, COMPLETED)) return 'completed';

    // 5. Plain acknowledgements.
    if (anyMatch(hay, ACK)) return 'ack';

    // Fallback: mail from a DSAR-vendor workflow domain is an action-required step.
    const etld = extractDomain(fromStr);
    const rawDom = fromStr.includes('@')
        ? fromStr.split('@').pop().replace(/[>\s]/g, '').toLowerCase()
        : '';
    if (DSAR_VENDOR_DOMAINS.includes(etld) || DSAR_VENDOR_DOMAINS.includes(rawDom)) {
        return 'verification_required';
    }

    // 6. Unrelated (marketing, off-topic, human chatter).
    return 'unrelated';
}
