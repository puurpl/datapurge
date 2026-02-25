/**
 * DataPurge Queue — Mass BCC send + individual fallback
 *
 * Primary flow: one email, BCC all brokers, minimal PII.
 * Fallback: send individually if user prefers.
 */

import { Store } from './store.js';
import { Templates } from './templates.js';

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
    'other': 'Other',
};

function getEmailMethod(broker) {
    if (!broker.optout || !broker.optout.methods) return null;
    return broker.optout.methods.find(m => m.type === 'email') || null;
}

function getEmailableBrokers() {
    if (!registryData) return [];
    return registryData.brokers
        .filter(b => getEmailMethod(b))
        .sort((a, b) => {
            const pa = CATEGORY_PRIORITY[a.category] ?? 99;
            const pb = CATEGORY_PRIORITY[b.category] ?? 99;
            if (pa !== pb) return pa - pb;
            return a.name.localeCompare(b.name);
        });
}

function getAllBrokerEmails() {
    return getEmailableBrokers()
        .map(b => getEmailMethod(b).email_to)
        .filter((v, i, a) => a.indexOf(v) === i); // dedupe
}

function buildMassEmail() {
    const fields = Store.getTemplateFields();
    if (!fields) return null;

    // Use preemptive_blanket — it's generic (no broker name), minimal PII
    const filled = Templates.fill('preemptive_blanket', fields, {
        name: 'your organization',
        domain: '',
    });
    if (!filled) return null;

    const allEmails = getAllBrokerEmails();

    return {
        bccList: allEmails,
        bccString: allEmails.join(', '),
        subject: filled.subject,
        body: filled.body,
        count: allEmails.length,
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

function esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function renderMassMode(container) {
    const mass = buildMassEmail();
    if (!mass) return;

    const brokers = getEmailableBrokers();

    // Build mailto with BCC — use encodeURIComponent (not URLSearchParams, which encodes spaces as +)
    const mailtoLink = `mailto:?bcc=${encodeURIComponent(mass.bccString)}&subject=${encodeURIComponent(mass.subject)}&body=${encodeURIComponent(mass.body)}`;

    container.innerHTML = `
        <h2 class="mb-2">Send to All Brokers at Once</h2>

        <div class="callout" style="text-align: left;">
            <h3 style="margin-bottom: 0.75rem;">How this works</h3>
            <p class="text-secondary" style="max-width: none;">
                One email, BCC'd to <strong>${mass.count} data broker privacy addresses</strong>.
                Uses the pre-emptive blanket template — it cites every applicable law, withdraws
                consent, and works regardless of whether a broker currently holds your data.
                Only your <strong>name and email</strong> are included (minimal PII).
            </p>
        </div>

        <div class="card mt-2">
            <div class="card-header">
                <div class="card-title">Open in your email client</div>
            </div>
            <p class="text-sm text-secondary mb-1">
                One click — opens a new email with all ${mass.count} broker addresses in BCC, subject and body pre-filled.
            </p>
            <a href="${mailtoLink}" class="btn btn-primary btn-lg" style="display:inline-block; text-align:center; width:100%;" target="_blank" rel="noopener">
                Send to ${mass.count} Brokers
            </a>
            <p class="text-sm text-secondary mt-1">
                After sending, come back and mark them as done below.
            </p>
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

        <div class="card mt-2">
            <div class="card-header">
                <div class="card-title">Mark as done</div>
            </div>
            <p class="text-sm text-secondary mb-1">
                After you've sent the email, click below to mark all brokers as contacted.
            </p>
            <button class="btn btn-success" id="btn-mark-all-sent">Mark All ${mass.count} Brokers as Sent</button>
        </div>

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
        navigator.clipboard.writeText(mass.bccString).then(() => showToast(`${mass.count} addresses copied`));
    });

    // Copy email
    container.querySelector('#btn-copy-email').addEventListener('click', () => {
        const text = `Subject: ${mass.subject}\n\n${mass.body}`;
        navigator.clipboard.writeText(text).then(() => showToast('Email copied'));
    });

    // Mark all sent
    container.querySelector('#btn-mark-all-sent').addEventListener('click', () => {
        if (confirm(`Mark all ${mass.count} brokers as sent?`)) {
            brokers.forEach(b => Store.markSent(b.id));
            showToast(`${mass.count} brokers marked as sent`);
            renderMassMode(container);
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
                navigator.clipboard.writeText(`Subject: ${filled.subject}\n\n${filled.body}`)
                    .then(() => showToast('Copied to clipboard'));
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
        registryData = await resp.json();
    },

    render(container) {
        const brokers = getEmailableBrokers();
        if (brokers.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <h3>No brokers with email opt-out available</h3>
                    <p>Check back soon — our registry is growing.</p>
                </div>`;
            return;
        }

        // Default to mass mode
        renderMassMode(container);
    },

    getRegistryData() {
        return registryData;
    },
};
