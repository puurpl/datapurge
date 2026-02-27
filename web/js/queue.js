/**
 * DataPurge Queue — Mass BCC send + individual fallback
 *
 * Primary flow: one email, BCC all brokers, minimal PII.
 * Fallback: send individually if user prefers.
 */

import { Store } from './store.js';
import { Templates } from './templates.js';
import { Share } from './share.js';

let registryData = null;

const CATEGORY_PRIORITY = {
    'data-aggregator': 0,
    'people-search': 1,
    'marketing-list': 2,
    'social-scraper': 3,
    'location-tracking': 4,
    'background-check': 5,
    'financial': 6,
    'public-records': 7,
    'other': 8,
};

const CATEGORY_LABELS = {
    'data-aggregator': 'Data Aggregator',
    'people-search': 'People Search',
    'marketing-list': 'Marketing List',
    'social-scraper': 'Social Scraper',
    'location-tracking': 'Location Tracking',
    'background-check': 'Background Check',
    'financial': 'Financial',
    'public-records': 'Public Records',
    'health': 'Health',
    'insurance': 'Insurance',
    'tenant-screening': 'Tenant Screening',
    'employment': 'Employment',
    'political': 'Political',
    'vehicle': 'Vehicle',
    'real-estate': 'Real Estate',
    'other': 'Other',
};

function getEmailMethod(broker) {
    if (!broker.optout || !broker.optout.methods) return null;
    return broker.optout.methods.find(m => m.type === 'email') || null;
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getEmailableBrokers() {
    if (!registryData) return [];
    return registryData.brokers
        .filter(b => {
            const m = getEmailMethod(b);
            return m && m.email_to && isValidEmail(m.email_to);
        })
        .sort((a, b) => {
            const pa = CATEGORY_PRIORITY[a.category] ?? 99;
            const pb = CATEGORY_PRIORITY[b.category] ?? 99;
            if (pa !== pb) return pa - pb;
            return a.name.localeCompare(b.name);
        });
}

function getNonEmailBrokers() {
    if (!registryData) return [];
    return registryData.brokers.filter(b => !getEmailMethod(b));
}

function getAllBrokerEmails() {
    return getEmailableBrokers()
        .map(b => getEmailMethod(b).email_to)
        .filter((v, i, a) => a.indexOf(v) === i);
}

function buildMassEmail() {
    const pii = Store.getPII();
    const fields = Store.getTemplateFields();
    if (!pii || !fields) return null;

    const templateId = Templates.selectBestTemplate(
        pii.state, pii.country, { legal: { ccpa: true } }
    );
    const filled = Templates.fill(templateId, fields, {
        name: 'your organization',
        domain: '',
    });
    if (!filled) return null;

    const allEmails = getAllBrokerEmails();

    const tmpl = Templates.getTemplate(templateId);
    return {
        bccList: allEmails,
        bccString: allEmails.join(', '),
        subject: filled.subject,
        body: filled.body,
        count: allEmails.length,
        templateId,
        templateName: tmpl?.name || templateId,
    };
}

function showToast(message) {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.className = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
}

function copyToClipboard(text, successMsg) {
    navigator.clipboard.writeText(text)
        .then(() => showToast(successMsg))
        .catch(() => showToast('Copy failed — try selecting the text manually'));
}

function esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// States that legally require honoring Global Privacy Control signals
const GPC_STATES = new Set([
    'California', 'Colorado', 'Connecticut', 'Delaware', 'Montana',
    'Nebraska', 'New Hampshire', 'New Jersey', 'Oregon', 'Texas',
    'Minnesota', 'Maryland',
]);

function getLocationNotices() {
    const pii = Store.getPII();
    if (!pii) return '';
    const notices = [];

    if (pii.state === 'California') {
        notices.push(`
            <div class="callout callout-action" style="text-align: left;">
                <h3 style="margin-bottom: 0.5rem;">&#127919; California DELETE Act — DROP</h3>
                <p class="text-secondary" style="max-width: none;">
                    As a California resident, you can also use the state's official
                    <strong>Delete Request and Opt-out Platform (DROP)</strong> — a single request
                    that reaches <strong>500+ registered data brokers</strong>, backed by law.
                    Brokers must process your request within 45 days or face $200/day fines.
                </p>
                <div class="mt-1">
                    <a href="https://privacy.ca.gov/drop/" class="btn btn-primary" target="_blank" rel="noopener">
                        Go to DROP (privacy.ca.gov)
                    </a>
                </div>
                <p class="text-sm text-secondary mt-1">
                    Use DROP <strong>in addition to</strong> the emails below for maximum coverage —
                    DROP covers registered brokers, our emails reach others that may not be registered.
                </p>
            </div>
        `);
    }

    const gpcLegal = GPC_STATES.has(pii.state);
    notices.push(`
        <div class="callout" style="text-align: left;">
            <h3 style="margin-bottom: 0.5rem;">&#128261; Enable Global Privacy Control (GPC)</h3>
            <p class="text-secondary" style="max-width: none;">
                GPC is a browser signal that automatically tells every website you visit
                to <strong>stop selling or sharing your data</strong>.
                ${gpcLegal
                    ? `In <strong>${esc(pii.state)}</strong>, websites are <strong>legally required</strong> to honor this signal — companies have been fined over $1M for ignoring it.`
                    : 'Many companies honor it voluntarily, and legal mandates are expanding across states.'}
                It works alongside the emails below for ongoing protection.
            </p>
            <p class="text-sm text-secondary mt-1" style="max-width: none;">
                <strong>Supported in:</strong> Firefox, Brave, and DuckDuckGo have it built in.
                For Chrome, Safari, and Edge, install an extension from the link below.
            </p>
            <div class="mt-1">
                <a href="https://globalprivacycontrol.org/" class="btn btn-outline" target="_blank" rel="noopener">
                    Enable GPC (globalprivacycontrol.org)
                </a>
            </div>
        </div>
    `);

    const euCountries = new Set([
        'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU',
        'IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES',
        'SE','IS','LI','NO','GB',
    ]);
    if (pii.country && pii.country !== 'US' && euCountries.has(pii.country)) {
        notices.push(`
            <div class="callout" style="text-align: left;">
                <h3 style="margin-bottom: 0.5rem;">&#127466;&#127482; GDPR — File a complaint if ignored</h3>
                <p class="text-secondary" style="max-width: none;">
                    Under GDPR, brokers must respond to your erasure request within <strong>30 days</strong>.
                    If a broker ignores you, you can file a formal complaint with your national
                    Data Protection Authority — this can result in significant fines against them.
                </p>
                <div class="mt-1">
                    <a href="https://edpb.europa.eu/about-edpb/about-edpb/members_en" class="btn btn-outline" target="_blank" rel="noopener">
                        Find your Data Protection Authority
                    </a>
                </div>
            </div>
        `);
    }

    return notices.join('');
}

// --- Email provider limits ---
// Each provider has a max BCC per message and a daily sending cap.
// mailto: URLs also have OS-level length limits (~2KB macOS, ~8KB Linux, ~32KB Windows).
const EMAIL_PROVIDERS = [
    { id: 'gmail',     name: 'Gmail',       maxBcc: 100, dailyCap: 500,  note: 'Limits each email to ~100 BCC recipients. 500 emails/day.' },
    { id: 'outlook',   name: 'Outlook / Hotmail', maxBcc: 100, dailyCap: 300, note: 'Supports up to 500 recipients per message but may throttle above 100.' },
    { id: 'yahoo',     name: 'Yahoo / AOL', maxBcc: 100, dailyCap: 500,  note: 'Limits BCC to ~200 per email. May flag mass sends above 100.' },
    { id: 'proton',    name: 'Proton Mail', maxBcc: 100, dailyCap: 150,  note: '100 recipients per message (free). 250 on paid plans. 150/day free cap.' },
    { id: 'icloud',    name: 'iCloud Mail', maxBcc: 100, dailyCap: 500,  note: 'Supports up to 500 recipients. Mailto links work well on Apple devices.' },
    { id: 'zoho',      name: 'Zoho Mail',   maxBcc: 100, dailyCap: 250,  note: '100 BCC recipients per email on most plans.' },
    { id: 'fastmail',  name: 'Fastmail',    maxBcc: 100, dailyCap: 500,  note: 'Supports large BCC lists. 100 per batch for consistent delivery.' },
    { id: 'other',     name: 'Other / Custom', maxBcc: 50,  dailyCap: null, note: 'Conservative default. Adjust the batch size below if your provider supports more.' },
];

// Map email domains → provider ID for auto-detection (recommendation only)
const DOMAIN_TO_PROVIDER = {
    'gmail.com': 'gmail', 'googlemail.com': 'gmail',
    'outlook.com': 'outlook', 'hotmail.com': 'outlook', 'live.com': 'outlook', 'msn.com': 'outlook',
    'yahoo.com': 'yahoo', 'yahoo.co.uk': 'yahoo', 'ymail.com': 'yahoo', 'aol.com': 'yahoo',
    'protonmail.com': 'proton', 'proton.me': 'proton', 'pm.me': 'proton',
    'icloud.com': 'icloud', 'me.com': 'icloud', 'mac.com': 'icloud',
    'zoho.com': 'zoho', 'zohomail.com': 'zoho',
    'fastmail.com': 'fastmail', 'fastmail.fm': 'fastmail',
};

function detectProviderId(email) {
    if (!email || typeof email !== 'string') return null;
    const domain = email.split('@')[1]?.toLowerCase();
    return domain ? (DOMAIN_TO_PROVIDER[domain] || null) : null;
}

const BATCH_SIZE_KEY = 'datapurge_batch_size';

function getSavedBatchSize() {
    try {
        const val = parseInt(localStorage.getItem(BATCH_SIZE_KEY));
        return val > 0 ? val : null;
    } catch { return null; }
}

function saveBatchSize(size) {
    try { localStorage.setItem(BATCH_SIZE_KEY, String(size)); } catch { /* ignore */ }
}

function buildBatches(allEmails, maxBcc, subject, body) {
    const batches = [];
    for (let i = 0; i < allEmails.length; i += maxBcc) {
        const slice = allEmails.slice(i, i + maxBcc);
        const bcc = slice.join(', ');
        const link = `mailto:?bcc=${encodeURIComponent(bcc)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        batches.push({ emails: slice, bcc, link, count: slice.length, start: i + 1, end: i + slice.length });
    }
    return batches;
}

function renderMassMode(container) {
    const mass = buildMassEmail();
    if (!mass) return;

    // Check if user already chose a batch size
    const saved = getSavedBatchSize();
    if (saved) {
        renderBatchSendFlow(container, mass, saved);
    } else {
        renderProviderPicker(container, mass);
    }
}

function renderProviderPicker(container, mass) {
    const brokers = getEmailableBrokers();
    const nonEmailBrokers = getNonEmailBrokers();
    const pii = Store.getPII();
    const detectedId = detectProviderId(pii?.email);

    container.innerHTML = `
        <h2 class="mb-2">Send to All Brokers at Once</h2>

        <div class="callout" style="text-align: left;">
            <h3 style="margin-bottom: 0.75rem;">How this works</h3>
            <p class="text-secondary" style="max-width: none;">
                We'll BCC <strong>${mass.count} data broker privacy addresses</strong> using
                <strong>${esc(mass.templateName)}</strong> — the strongest legal template for your
                location. Every provider limits how many BCC recipients you can include per email,
                so we'll split them into batches for you.
            </p>
        </div>

        <div class="card mt-2">
            <div class="card-header">
                <div class="card-title">Which email provider do you use?</div>
            </div>
            <p class="text-sm text-secondary mb-1">
                This determines how many brokers to include per email. Your choice is saved for next time.
                ${detectedId ? `We detected <strong>${esc(EMAIL_PROVIDERS.find(p => p.id === detectedId)?.name || '')}</strong> from your email address.` : ''}
            </p>
            <div id="provider-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem;">
                ${EMAIL_PROVIDERS.map(p => `
                    <button class="btn ${p.id === detectedId ? 'btn-primary' : 'btn-outline'} btn-provider" data-provider="${p.id}"
                        style="text-align: left; padding: 0.75rem; height: auto; white-space: normal;">
                        <strong>${esc(p.name)}${p.id === detectedId ? ' (detected)' : ''}</strong>
                        <span class="text-sm ${p.id === detectedId ? '' : 'text-secondary'}" style="display: block; margin-top: 0.25rem;">
                            ${p.maxBcc} per email${p.dailyCap ? ` · ${p.dailyCap}/day` : ''}
                        </span>
                    </button>
                `).join('')}
            </div>

            <details class="mt-2">
                <summary class="text-sm text-secondary" style="cursor: pointer;">Provider limits explained</summary>
                <div class="mt-1" style="font-size: 0.8rem;">
                    <table style="width: 100%; border-collapse: collapse;">
                        <thead>
                            <tr style="border-bottom: 1px solid var(--color-border);">
                                <th style="text-align: left; padding: 0.25rem 0.5rem;">Provider</th>
                                <th style="text-align: right; padding: 0.25rem 0.5rem;">Per email</th>
                                <th style="text-align: right; padding: 0.25rem 0.5rem;">Per day</th>
                                <th style="text-align: left; padding: 0.25rem 0.5rem;">Notes</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${EMAIL_PROVIDERS.filter(p => p.id !== 'other').map(p => `
                                <tr style="border-bottom: 1px solid var(--color-border);">
                                    <td style="padding: 0.25rem 0.5rem;">${esc(p.name)}</td>
                                    <td style="text-align: right; padding: 0.25rem 0.5rem;">${p.maxBcc}</td>
                                    <td style="text-align: right; padding: 0.25rem 0.5rem;">${p.dailyCap || '—'}</td>
                                    <td style="padding: 0.25rem 0.5rem;" class="text-secondary">${esc(p.note)}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </details>

            <div class="mt-2" style="display: flex; align-items: center; gap: 0.5rem;">
                <label class="text-sm" for="custom-batch-size">Or set a custom batch size:</label>
                <input type="number" id="custom-batch-size" min="1" max="500" placeholder="e.g. 75"
                    style="width: 80px; padding: 0.35rem 0.5rem; border: 1px solid var(--color-border); border-radius: 4px; font-size: 0.9rem;">
                <button class="btn btn-outline btn-sm" id="btn-custom-batch">Apply</button>
            </div>
        </div>

        ${nonEmailBrokers.length > 0 ? `
        <div class="callout mt-2" style="text-align: left;">
            <p class="text-sm text-secondary" style="max-width: none;">
                <strong>${nonEmailBrokers.length} broker${nonEmailBrokers.length > 1 ? 's' : ''}</strong> require manual opt-out
                (web form or phone). Check the <a href="#brokers">Brokers</a> directory for details.
            </p>
        </div>
        ` : ''}

        <div class="mt-3" style="border-top: 1px solid var(--color-border); padding-top: 1.5rem;">
            <div class="flex items-center justify-between mb-1">
                <h3>Prefer to send individually?</h3>
                <button class="btn btn-outline btn-sm" id="btn-individual-mode">Switch to Individual Mode</button>
            </div>
            <p class="text-sm text-secondary">
                Send one-by-one with broker-specific templates for a stronger paper trail.
            </p>
        </div>
    `;

    // Provider button clicks
    container.querySelectorAll('.btn-provider').forEach(btn => {
        btn.addEventListener('click', () => {
            const providerId = btn.getAttribute('data-provider');
            const provider = EMAIL_PROVIDERS.find(p => p.id === providerId);
            if (provider) {
                saveBatchSize(provider.maxBcc);
                renderBatchSendFlow(container, mass, provider.maxBcc);
            }
        });
    });

    // Custom batch size
    container.querySelector('#btn-custom-batch').addEventListener('click', () => {
        const input = container.querySelector('#custom-batch-size');
        const val = parseInt(input.value);
        if (val > 0 && val <= 500) {
            saveBatchSize(val);
            renderBatchSendFlow(container, mass, val);
        } else {
            input.style.borderColor = 'var(--color-warning)';
            showToast('Enter a number between 1 and 500');
        }
    });

    // Switch to individual
    container.querySelector('#btn-individual-mode').addEventListener('click', () => {
        renderIndividualMode(container);
    });
}

function renderBatchSendFlow(container, mass, batchSize) {
    const brokers = getEmailableBrokers();
    const nonEmailBrokers = getNonEmailBrokers();
    const batches = buildBatches(mass.bccList, batchSize, mass.subject, mass.body);
    const totalEmails = batches.length;

    container.innerHTML = `
        <h2 class="mb-2">Send to All Brokers at Once</h2>

        <div class="callout" style="text-align: left;">
            <h3 style="margin-bottom: 0.75rem;">How this works</h3>
            <p class="text-secondary" style="max-width: none;">
                ${totalEmails === 1
                    ? `One email, BCC'd to <strong>${mass.count} data broker privacy addresses</strong>.`
                    : `<strong>${totalEmails} emails</strong>, each with up to <strong>${batchSize} BCC recipients</strong> (${mass.count} total).`}
                Using <strong>${esc(mass.templateName)}</strong> — the strongest template for your
                location. It cites every applicable law, withdraws consent, demands written
                confirmation, and warns of regulatory action for non-compliance.
            </p>
            <p class="text-sm text-secondary mt-1">
                Batch size: <strong>${batchSize}</strong> per email.
                <button class="btn-link text-sm" id="btn-change-provider" style="background:none; border:none; color:var(--color-primary); cursor:pointer; padding:0; text-decoration:underline;">Change</button>
            </p>
        </div>

        ${getLocationNotices()}

        <div class="card mt-2">
            <div class="card-header">
                <div class="card-title">Step 1 — Copy the email body</div>
            </div>
            <p class="text-sm text-secondary mb-1">
                This is the same for ${totalEmails === 1 ? 'the email' : 'every batch'} — copy once${totalEmails > 1 ? ', reuse for each email' : ''}.
            </p>
            <div class="email-preview">
                <button class="email-preview-toggle" id="toggle-body">
                    <span>Preview email</span>
                    <span>&#9662;</span>
                </button>
                <div class="email-preview-content" id="email-body"><strong>Subject:</strong> ${esc(mass.subject)}

${esc(mass.body)}</div>
            </div>
            <div class="mt-1">
                <button class="btn btn-primary" id="btn-copy-email" style="width:100%;">Copy Subject + Body</button>
            </div>
        </div>

        <div class="card mt-2">
            <div class="card-header">
                <div class="card-title">Step 2 — Send ${totalEmails} email${totalEmails > 1 ? 's' : ''}</div>
            </div>
            <p class="text-sm text-secondary mb-1">
                ${totalEmails === 1
                    ? 'Copy the BCC addresses below and paste into the <strong>BCC</strong> field of a new email.'
                    : 'For each batch: create a new email, paste the subject + body, then copy and paste the BCC addresses.'}
            </p>
            <div id="batch-list">
                ${batches.map((b, i) => `
                    <div class="card mt-1 batch-card" data-batch="${i}" style="border-left: 3px solid var(--color-border);">
                        <div class="flex items-center justify-between mb-1">
                            <strong class="text-sm">
                                ${totalEmails === 1 ? `All ${b.count} addresses` : `Email ${i + 1} of ${totalEmails} — ${b.count} addresses`}
                            </strong>
                            <span class="badge batch-status" id="batch-status-${i}"></span>
                        </div>
                        <div class="email-preview">
                            <button class="email-preview-toggle" data-toggle-batch="${i}">
                                <span>${totalEmails === 1 ? `Show all ${b.count} addresses` : `Show ${b.count} addresses (#${b.start}–${b.end})`}</span>
                                <span>&#9662;</span>
                            </button>
                            <div class="email-preview-content batch-bcc" id="batch-bcc-${i}">${esc(b.bcc)}</div>
                        </div>
                        <div class="mt-1 flex" style="gap: 0.5rem; flex-wrap: wrap;">
                            <button class="btn btn-primary btn-sm btn-copy-batch" data-batch="${i}">Copy BCC Addresses</button>
                            <a href="${b.link}" class="btn btn-outline btn-sm btn-mailto-batch" data-batch="${i}">Open via mailto</a>
                            <button class="btn btn-success btn-sm btn-batch-done" data-batch="${i}">Sent</button>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>

        <!-- Post-send prompt (hidden initially, shown on return) -->
        <div class="card mt-2" id="post-send-prompt" style="display:none; border-color: var(--color-success);">
            <div class="card-header">
                <div class="card-title" style="color: var(--color-success);">Welcome back! Did you send it?</div>
            </div>
            <p class="text-sm text-secondary mb-1">
                Mark the batch as done above, or mark everything at once below.
            </p>
            <button class="btn btn-success btn-lg" id="btn-mark-all-sent-prompt" style="width:100%;">
                Mark All ${mass.count} Brokers as Sent
            </button>
        </div>

        <div class="card mt-2" id="mark-done-card">
            <div class="card-header">
                <div class="card-title">Step 3 — Mark all as done</div>
            </div>
            <p class="text-sm text-secondary mb-1">
                Once you've sent ${totalEmails === 1 ? 'the email' : `all ${totalEmails} emails`},
                click below to mark all brokers as contacted and start tracking legal deadlines.
            </p>
            <button class="btn btn-success" id="btn-mark-all-sent" style="width:100%;">Mark All ${mass.count} Brokers as Sent</button>
        </div>

        ${nonEmailBrokers.length > 0 ? `
        <div class="callout mt-2" style="text-align: left;">
            <p class="text-sm text-secondary" style="max-width: none;">
                <strong>${nonEmailBrokers.length} broker${nonEmailBrokers.length > 1 ? 's' : ''}</strong> require manual opt-out
                (web form or phone). Check the <a href="#brokers">Brokers</a> directory for details.
            </p>
        </div>
        ` : ''}

        <div class="mt-3" style="border-top: 1px solid var(--color-border); padding-top: 1.5rem;">
            <div class="flex items-center justify-between mb-1">
                <h3>Prefer to send individually?</h3>
                <button class="btn btn-outline btn-sm" id="btn-individual-mode">Switch to Individual Mode</button>
            </div>
            <p class="text-sm text-secondary">
                Send one-by-one with broker-specific templates for a stronger paper trail.
            </p>
        </div>

        <div class="mt-3">
            <h3 class="queue-list-header">All ${mass.count} broker addresses</h3>
            <div id="broker-list"></div>
        </div>
    `;

    // --- Event listeners ---

    // Change provider / batch size
    container.querySelector('#btn-change-provider').addEventListener('click', () => {
        try { localStorage.removeItem(BATCH_SIZE_KEY); } catch { /* ignore */ }
        renderProviderPicker(container, mass);
    });

    // Post-send UX: detect when user returns after clicking a mailto batch
    let mailtoClicked = false;
    const postSendPrompt = container.querySelector('#post-send-prompt');

    container.querySelectorAll('.btn-mailto-batch').forEach(btn => {
        btn.addEventListener('click', () => { mailtoClicked = true; });
    });

    const handleVisibility = () => {
        if (mailtoClicked && !document.hidden && postSendPrompt) {
            postSendPrompt.style.display = '';
            postSendPrompt.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            document.removeEventListener('visibilitychange', handleVisibility);
        }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    container.querySelector('#btn-mark-all-sent-prompt')?.addEventListener('click', () => {
        brokers.forEach(b => Store.markSent(b.id));
        showToast(`${mass.count} brokers marked as sent`);
        renderCompletionCard(container, mass.count);
    });

    // Toggle email body preview
    container.querySelector('#toggle-body').addEventListener('click', () => {
        container.querySelector('#email-body').classList.toggle('open');
    });

    // Toggle per-batch BCC previews
    container.querySelectorAll('[data-toggle-batch]').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = btn.getAttribute('data-toggle-batch');
            container.querySelector(`#batch-bcc-${idx}`).classList.toggle('open');
        });
    });

    // Copy BCC for a batch
    container.querySelectorAll('.btn-copy-batch').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.getAttribute('data-batch'));
            copyToClipboard(batches[idx].bcc, `${batches[idx].count} addresses copied${totalEmails > 1 ? ` (email ${idx + 1} of ${totalEmails})` : ''}`);
        });
    });

    // Mark individual batch as sent (visual indicator only)
    container.querySelectorAll('.btn-batch-done').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = btn.getAttribute('data-batch');
            const card = container.querySelector(`.batch-card[data-batch="${idx}"]`);
            const status = container.querySelector(`#batch-status-${idx}`);
            if (card) card.style.borderLeftColor = 'var(--color-success)';
            if (status) { status.textContent = 'Sent'; status.className = 'badge badge-sent batch-status'; }
            btn.disabled = true;
            btn.textContent = 'Done';
            showToast(`Email ${parseInt(idx) + 1} of ${totalEmails} marked as sent`);
        });
    });

    // Copy email body
    container.querySelector('#btn-copy-email').addEventListener('click', () => {
        const text = `Subject: ${mass.subject}\n\n${mass.body}`;
        copyToClipboard(text, 'Email copied — paste into a new email');
    });

    // Mark all sent
    container.querySelector('#btn-mark-all-sent').addEventListener('click', () => {
        if (confirm(`Mark all ${mass.count} brokers as sent?`)) {
            brokers.forEach(b => Store.markSent(b.id));
            showToast(`${mass.count} brokers marked as sent`);
            renderCompletionCard(container, mass.count);
        }
    });

    // Switch to individual
    container.querySelector('#btn-individual-mode').addEventListener('click', () => {
        renderIndividualMode(container);
    });

    // Render broker list
    const listEl = container.querySelector('#broker-list');
    listEl.innerHTML = brokers.map(b => {
        const email = getEmailMethod(b).email_to;
        const sent = Store.isSent(b.id);
        return `
            <div class="queue-item ${sent ? 'sent' : ''}">
                <div>
                    <span class="queue-item-name">${esc(b.name)}</span>
                    <span class="text-muted text-sm"> &middot; ${esc(email)}</span>
                </div>
                <div class="queue-item-meta">
                    <span class="badge badge-category">${esc(CATEGORY_LABELS[b.category] || b.category)}</span>
                    ${sent ? '<span class="badge badge-sent">Sent</span>' : ''}
                </div>
            </div>
        `;
    }).join('');
}

function renderCompletionCard(container, count) {
    container.innerHTML = `
        <div class="callout" style="text-align: center; padding: 3rem 2rem;">
            <div class="callout-icon" style="font-size: 3rem;">&#127881;</div>
            <h2 style="margin-bottom: 0.75rem;">Opt-out requests sent!</h2>
            <p class="text-secondary" style="max-width: 480px; margin: 0 auto 1.5rem;">
                You just sent legally-backed deletion requests to <strong>${count} data brokers</strong>.
                Each one now has a legal deadline to respond. Track their progress in the
                <a href="#progress">Progress</a> tab.
            </p>

            <div class="btn-group" style="justify-content: center;">
                <a href="#progress" class="btn btn-primary">Track Deadlines</a>
                <a href="#share" class="btn btn-outline">Share DataPurge</a>
            </div>

            ${Share.renderShareBar()}
        </div>
    `;
}

function renderIndividualMode(container) {
    const pii = Store.getPII();
    const fields = Store.getTemplateFields();
    if (!pii || !fields) return;

    const brokers = getEmailableBrokers();
    const queue = brokers.map(broker => {
        const emailMethod = getEmailMethod(broker);
        const templateId = Templates.selectBestTemplate(pii.state, pii.country, broker);
        const filled = Templates.fill(templateId, fields, broker);
        const mailtoLink = Templates.generateMailtoLink(
            emailMethod.email_to, filled.subject, filled.body
        );
        return { broker, emailMethod, templateId, filled, mailtoLink, sent: Store.isSent(broker.id) };
    });

    const unsent = queue.filter(q => !q.sent);
    const sentCount = queue.filter(q => q.sent).length;

    container.innerHTML = `
        <div class="flex items-center justify-between mb-2">
            <h2>Individual Mode</h2>
            <button class="btn btn-outline btn-sm" id="btn-mass-mode">Back to Mass Send</button>
        </div>
        <div class="queue-summary">
            <div class="queue-summary-stat">
                <div class="value">${unsent.length}</div>
                <div class="label">Remaining</div>
            </div>
            <div class="queue-summary-stat">
                <div class="value">${sentCount}</div>
                <div class="label">Sent</div>
            </div>
            <div class="queue-summary-stat">
                <div class="value">${queue.length}</div>
                <div class="label">Total</div>
            </div>
        </div>
        <div id="queue-current-slot"></div>
        <div class="queue-list-header mt-2">All brokers</div>
        <div id="queue-list"></div>
    `;

    container.querySelector('#btn-mass-mode').addEventListener('click', () => {
        renderMassMode(container);
    });

    const currentSlot = container.querySelector('#queue-current-slot');
    const listEl = container.querySelector('#queue-list');

    const renderAll = () => {
        const q = brokers.map(broker => {
            const emailMethod = getEmailMethod(broker);
            const templateId = Templates.selectBestTemplate(pii.state, pii.country, broker);
            const filled = Templates.fill(templateId, fields, broker);
            const mailtoLink = Templates.generateMailtoLink(
                emailMethod.email_to, filled.subject, filled.body
            );
            return { broker, emailMethod, templateId, filled, mailtoLink, sent: Store.isSent(broker.id) };
        });

        const newUnsent = q.filter(x => !x.sent);
        const newSentCount = q.filter(x => x.sent).length;

        container.querySelector('.queue-summary').innerHTML = `
            <div class="queue-summary-stat">
                <div class="value">${newUnsent.length}</div>
                <div class="label">Remaining</div>
            </div>
            <div class="queue-summary-stat">
                <div class="value">${newSentCount}</div>
                <div class="label">Sent</div>
            </div>
            <div class="queue-summary-stat">
                <div class="value">${q.length}</div>
                <div class="label">Total</div>
            </div>
        `;

        const currentIdx = q.findIndex(x => !x.sent);
        if (currentIdx >= 0) {
            const item = q[currentIdx];
            const { broker, emailMethod, filled, mailtoLink } = item;
            const difficulty = broker.optout?.difficulty || 'unknown';

            currentSlot.innerHTML = `
                <div class="queue-current">
                    <div class="broker-name">${esc(broker.name)}</div>
                    <div class="broker-domain">${esc(broker.domain)}</div>
                    <div class="broker-meta">
                        <span class="badge badge-category">${esc(CATEGORY_LABELS[broker.category] || broker.category)}</span>
                        <span class="badge badge-${difficulty}">${esc(difficulty)}</span>
                    </div>
                    <div class="email-preview">
                        <button class="email-preview-toggle" data-toggle="preview">
                            <span>Preview email to ${esc(emailMethod.email_to)}</span>
                            <span>&#9662;</span>
                        </button>
                        <div class="email-preview-content" id="preview-body"><strong>Subject:</strong> ${esc(filled.subject)}

${esc(filled.body)}</div>
                    </div>
                    <div class="queue-actions">
                        <a href="${mailtoLink}" class="btn btn-success" target="_blank" rel="noopener">Open in Email Client</a>
                        <button class="btn btn-outline" id="btn-copy">Copy to Clipboard</button>
                    </div>
                    <div class="queue-actions mt-1">
                        <button class="btn btn-primary" id="btn-sent">Mark as Sent</button>
                        <button class="btn btn-ghost" id="btn-skip">Skip</button>
                    </div>
                </div>
            `;

            currentSlot.querySelector('[data-toggle="preview"]').addEventListener('click', () => {
                currentSlot.querySelector('#preview-body').classList.toggle('open');
            });
            currentSlot.querySelector('#btn-copy').addEventListener('click', () => {
                copyToClipboard(`Subject: ${filled.subject}\n\n${filled.body}`, 'Copied to clipboard');
            });
            currentSlot.querySelector('#btn-sent').addEventListener('click', () => {
                Store.markSent(broker.id);
                renderAll();
            });
            currentSlot.querySelector('#btn-skip').addEventListener('click', renderAll);
        } else {
            currentSlot.innerHTML = `
                <div class="callout">
                    <div class="callout-icon">&#127881;</div>
                    <h3>All done!</h3>
                    <p>You've sent opt-out requests to every broker. Check the Progress tab to track responses.</p>
                    ${Share.renderShareBar()}
                </div>`;
        }

        listEl.innerHTML = q.map(item => `
            <div class="queue-item ${item.sent ? 'sent' : ''}">
                <div>
                    <span class="queue-item-name">${esc(item.broker.name)}</span>
                    <span class="text-muted text-sm"> &middot; ${esc(item.broker.domain)}</span>
                </div>
                <div class="queue-item-meta">
                    <span class="badge badge-category">${esc(CATEGORY_LABELS[item.broker.category] || item.broker.category)}</span>
                    ${item.sent ? '<span class="badge badge-sent">Sent</span>' : ''}
                </div>
            </div>
        `).join('');
    };

    renderAll();
}

export const Queue = {
    async load() {
        const resp = await fetch('data/registry.json');
        if (!resp.ok) throw new Error(`Failed to load registry: ${resp.status}`);
        registryData = await resp.json();
    },

    /** Shared access to loaded registry for other modules */
    getRegistryData() {
        return registryData;
    },

    render(container) {
        if (!registryData) {
            container.innerHTML = `
                <div class="empty-state">
                    <h3>Unable to load broker data</h3>
                    <p>Please check your connection and reload the page.</p>
                    <button class="btn btn-outline mt-2" onclick="location.reload()">Reload</button>
                </div>`;
            return;
        }

        const brokers = getEmailableBrokers();
        if (brokers.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <h3>No brokers with email opt-out available</h3>
                    <p>Check back soon — our registry is growing.</p>
                </div>`;
            return;
        }

        renderMassMode(container);
    },
};
