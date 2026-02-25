/**
 * DataPurge Queue — Email queue with priority sorting
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

function buildQueue() {
    const pii = Store.getPII();
    const fields = Store.getTemplateFields();
    if (!pii || !fields || !registryData) return [];

    return registryData.brokers
        .filter(b => getEmailMethod(b))
        .sort((a, b) => {
            const pa = CATEGORY_PRIORITY[a.category] ?? 99;
            const pb = CATEGORY_PRIORITY[b.category] ?? 99;
            if (pa !== pb) return pa - pb;
            return a.name.localeCompare(b.name);
        })
        .map(broker => {
            const emailMethod = getEmailMethod(broker);
            const templateId = Templates.selectBestTemplate(pii.state, pii.country, broker);
            const filled = Templates.fill(templateId, fields, broker);
            const mailtoLink = Templates.generateMailtoLink(
                emailMethod.email_to, filled.subject, filled.body
            );
            return {
                broker,
                emailMethod,
                templateId,
                filled,
                mailtoLink,
                sent: Store.isSent(broker.id),
            };
        });
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

function renderCurrent(container, item, onNext) {
    const { broker, emailMethod, filled, mailtoLink, templateId } = item;
    const difficulty = broker.optout?.difficulty || 'unknown';
    const relisting = broker.timing?.relisting_likelihood || 'unknown';

    container.innerHTML = `
        <div class="queue-current">
            <div class="broker-name">${esc(broker.name)}</div>
            <div class="broker-domain">${esc(broker.domain)}</div>
            <div class="broker-meta">
                <span class="badge badge-category">${esc(CATEGORY_LABELS[broker.category] || broker.category)}</span>
                <span class="badge badge-${difficulty}">${esc(difficulty)}</span>
                ${relisting === 'high' || relisting === 'certain'
                    ? `<span class="badge badge-outline">Re-lists: ${esc(relisting)}</span>`
                    : ''}
            </div>
            ${broker.data_types && broker.data_types.length
                ? `<div class="tag-list mb-1">${broker.data_types.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>`
                : ''}
            <div class="email-preview">
                <button class="email-preview-toggle" data-toggle="preview">
                    <span>Preview email to ${esc(emailMethod.email_to)}</span>
                    <span>&#9662;</span>
                </button>
                <div class="email-preview-content" id="preview-body">
<strong>Subject:</strong> ${esc(filled.subject)}

${esc(filled.body)}</div>
            </div>
            <div class="queue-actions">
                <a href="${mailtoLink}" class="btn btn-success" id="btn-mailto" target="_blank" rel="noopener">
                    Open in Email Client
                </a>
                <button class="btn btn-outline" id="btn-copy">
                    Copy to Clipboard
                </button>
            </div>
            <div class="queue-actions mt-1">
                <button class="btn btn-primary" id="btn-sent">Mark as Sent</button>
                <button class="btn btn-ghost" id="btn-skip">Skip</button>
            </div>
        </div>
    `;

    container.querySelector('[data-toggle="preview"]').addEventListener('click', () => {
        container.querySelector('#preview-body').classList.toggle('open');
    });

    container.querySelector('#btn-copy').addEventListener('click', () => {
        const text = `Subject: ${filled.subject}\n\n${filled.body}`;
        navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard'));
    });

    container.querySelector('#btn-sent').addEventListener('click', () => {
        Store.markSent(broker.id);
        onNext();
    });

    container.querySelector('#btn-skip').addEventListener('click', onNext);
}

function esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

export const Queue = {
    async load() {
        const resp = await fetch('data/registry.json');
        registryData = await resp.json();
    },

    render(container) {
        const queue = buildQueue();
        const unsent = queue.filter(q => !q.sent);
        const sentCount = queue.filter(q => q.sent).length;
        const total = queue.length;

        if (total === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <h3>No brokers with email opt-out available</h3>
                    <p>Check back soon — our registry is growing.</p>
                </div>`;
            return;
        }

        container.innerHTML = `
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
                    <div class="value">${total}</div>
                    <div class="label">Total</div>
                </div>
            </div>
            <div id="queue-current-slot"></div>
            <div class="queue-list-header mt-2">All brokers</div>
            <div id="queue-list"></div>
        `;

        const currentSlot = container.querySelector('#queue-current-slot');
        const listEl = container.querySelector('#queue-list');
        let currentIdx = queue.findIndex(q => !q.sent);

        const renderAll = () => {
            const q = buildQueue();
            const newUnsent = q.filter(x => !x.sent);
            const newSentCount = q.filter(x => x.sent).length;

            // Update summary
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

            currentIdx = q.findIndex(x => !x.sent);
            if (currentIdx >= 0) {
                renderCurrent(currentSlot, q[currentIdx], renderAll);
            } else {
                currentSlot.innerHTML = `
                    <div class="callout">
                        <div class="callout-icon">&#127881;</div>
                        <h3>All done!</h3>
                        <p>You've sent opt-out requests to every broker in our registry. Check the Progress tab to track responses.</p>
                    </div>`;
            }

            // Render list
            listEl.innerHTML = q.map((item, i) => `
                <div class="queue-item ${item.sent ? 'sent' : ''}" data-idx="${i}">
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
    },

    getRegistryData() {
        return registryData;
    },
};
