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

function renderMassMode(container) {
    const mass = buildMassEmail();
    if (!mass) return;

    const brokers = getEmailableBrokers();
    const nonEmailBrokers = getNonEmailBrokers();

    const mailtoLink = `mailto:?bcc=${encodeURIComponent(mass.bccString)}&subject=${encodeURIComponent(mass.subject)}&body=${encodeURIComponent(mass.body)}`;

    container.innerHTML = `
        <h2 class="mb-2">Send to All Brokers at Once</h2>

        <div class="callout" style="text-align: left;">
            <h3 style="margin-bottom: 0.75rem;">How this works</h3>
            <p class="text-secondary" style="max-width: none;">
                One email, BCC'd to <strong>${mass.count} data broker privacy addresses</strong>.
                Using <strong>${esc(mass.templateName)}</strong> — the strongest template for your
                location. It cites every applicable law, withdraws consent, demands written
                confirmation, and warns of regulatory action for non-compliance.
            </p>
        </div>

        ${getLocationNotices()}

        <div class="card mt-2">
            <div class="card-header">
                <div class="card-title">Open in your email client</div>
            </div>
            <p class="text-sm text-secondary mb-1">
                One click — opens a new email with all ${mass.count} broker addresses in BCC, subject and body pre-filled.
            </p>
            <a href="${mailtoLink}" class="btn btn-primary btn-lg" id="btn-mailto" style="display:inline-block; text-align:center; width:100%;" target="_blank" rel="noopener">
                Send to ${mass.count} Brokers
            </a>
            <p class="text-sm text-secondary mt-1">
                After sending, come back and mark them as done below.
            </p>
        </div>

        <!-- Post-send prompt (hidden initially, shown on return) -->
        <div class="card mt-2" id="post-send-prompt" style="display:none; border-color: var(--color-success);">
            <div class="card-header">
                <div class="card-title" style="color: var(--color-success);">Welcome back! Did you send it?</div>
            </div>
            <p class="text-sm text-secondary mb-1">
                If you sent the email, mark all brokers as contacted to start tracking deadlines.
            </p>
            <button class="btn btn-success btn-lg" id="btn-mark-all-sent-prompt" style="width:100%;">
                Yes — Mark All ${mass.count} Brokers as Sent
            </button>
        </div>

        <details class="mt-2">
            <summary class="text-sm text-secondary" style="cursor:pointer;">Email client didn't work? Copy manually instead</summary>
            <div class="card mt-1">
                <div class="card-header">
                    <div class="card-title">BCC addresses</div>
                </div>
                <p class="text-sm text-secondary mb-1">
                    Paste into the BCC field of a new email.
                </p>
                <div class="email-preview">
                    <button class="email-preview-toggle" id="toggle-bcc">
                        <span>Show all ${mass.count} addresses</span>
                        <span>&#9662;</span>
                    </button>
                    <div class="email-preview-content" id="bcc-list">${esc(mass.bccString)}</div>
                </div>
                <div class="mt-1">
                    <button class="btn btn-outline" id="btn-copy-bcc">Copy All BCC Addresses</button>
                </div>
            </div>

            <div class="card mt-1">
                <div class="card-header">
                    <div class="card-title">Email subject + body</div>
                </div>
                <div class="email-preview">
                    <button class="email-preview-toggle" id="toggle-body">
                        <span>Preview email</span>
                        <span>&#9662;</span>
                    </button>
                    <div class="email-preview-content" id="email-body"><strong>Subject:</strong> ${esc(mass.subject)}

${esc(mass.body)}</div>
                </div>
                <div class="mt-1">
                    <button class="btn btn-outline" id="btn-copy-email">Copy Subject + Body</button>
                </div>
            </div>
        </details>

        <div class="card mt-2" id="mark-done-card">
            <div class="card-header">
                <div class="card-title">Mark as done</div>
            </div>
            <p class="text-sm text-secondary mb-1">
                After you've sent the email, click below to mark all brokers as contacted.
            </p>
            <button class="btn btn-success" id="btn-mark-all-sent">Mark All ${mass.count} Brokers as Sent</button>
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
                Send one-by-one for a stronger paper trail per broker.
            </p>
        </div>

        <div class="mt-3">
            <h3 class="queue-list-header">All ${mass.count} broker addresses</h3>
            <div id="broker-list"></div>
        </div>
    `;

    // Post-send UX: detect when user clicks mailto then returns
    let mailtoClicked = false;
    const mailtoBtn = container.querySelector('#btn-mailto');
    const postSendPrompt = container.querySelector('#post-send-prompt');

    mailtoBtn.addEventListener('click', () => {
        mailtoClicked = true;
    });

    // Show prompt when user returns to tab after clicking mailto
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

    // Toggle BCC list
    container.querySelector('#toggle-bcc').addEventListener('click', () => {
        container.querySelector('#bcc-list').classList.toggle('open');
    });

    // Toggle email body
    container.querySelector('#toggle-body').addEventListener('click', () => {
        container.querySelector('#email-body').classList.toggle('open');
    });

    // Copy BCC
    container.querySelector('#btn-copy-bcc').addEventListener('click', () => {
        copyToClipboard(mass.bccString, `${mass.count} addresses copied`);
    });

    // Copy email
    container.querySelector('#btn-copy-email').addEventListener('click', () => {
        const text = `Subject: ${mass.subject}\n\n${mass.body}`;
        copyToClipboard(text, 'Email copied');
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
