/**
 * DataPurge App — Main entry point, router, view initialization
 */

import { Store } from './store.js';
import { Templates } from './templates.js';
import { Queue } from './queue.js';
import { Brokers } from './brokers.js';
import { Progress } from './progress.js';

const US_STATES = [
    'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado',
    'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho',
    'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana',
    'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota',
    'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada',
    'New Hampshire', 'New Jersey', 'New Mexico', 'New York',
    'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon',
    'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota',
    'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington',
    'West Virginia', 'Wisconsin', 'Wyoming', 'District of Columbia',
];

const EU_COUNTRIES = {
    AT: 'Austria', BE: 'Belgium', BG: 'Bulgaria', HR: 'Croatia', CY: 'Cyprus',
    CZ: 'Czechia', DK: 'Denmark', EE: 'Estonia', FI: 'Finland', FR: 'France',
    DE: 'Germany', GR: 'Greece', HU: 'Hungary', IE: 'Ireland', IT: 'Italy',
    LV: 'Latvia', LT: 'Lithuania', LU: 'Luxembourg', MT: 'Malta', NL: 'Netherlands',
    PL: 'Poland', PT: 'Portugal', RO: 'Romania', SK: 'Slovakia', SI: 'Slovenia',
    ES: 'Spain', SE: 'Sweden', IS: 'Iceland', LI: 'Liechtenstein', NO: 'Norway',
    GB: 'United Kingdom',
};

// --- Router ---

function getHash() {
    return (location.hash || '#setup').slice(1);
}

function route() {
    const hash = getHash();

    // Redirect to setup if PII required but missing
    if ((hash === 'queue' || hash === 'progress') && !Store.hasPII()) {
        location.hash = '#setup';
        return;
    }

    // Show/hide views
    document.querySelectorAll('.view').forEach(v => v.hidden = true);
    const el = document.getElementById(`view-${hash}`);
    if (el) {
        el.hidden = false;
        initView(hash, el);
    } else {
        // Default to setup
        document.getElementById('view-setup').hidden = false;
        initView('setup', document.getElementById('view-setup'));
    }

    // Update nav
    document.querySelectorAll('.nav-tab').forEach(a => {
        a.classList.toggle('active', a.getAttribute('href') === `#${hash}`);
    });
}

function initView(name, el) {
    switch (name) {
        case 'setup': renderSetup(el); break;
        case 'queue': Queue.render(el); break;
        case 'brokers': Brokers.render(el); break;
        case 'progress': Progress.render(el, Queue.getRegistryData()); break;
    }
}

// --- Setup View ---

function renderSetup(container) {
    const existing = Store.getPII();

    container.innerHTML = `
        <div class="setup-page">
            <div class="container-narrow">
                <div class="setup-header">
                    <h2>Enter your information</h2>
                    <p class="text-secondary">This is used to fill opt-out email templates. Nothing is transmitted.</p>
                </div>

                <div class="privacy-notice">
                    <span class="privacy-notice-icon">&#128274;</span>
                    <div>
                        <strong>Privacy first.</strong> Your information is stored only in your browser's
                        session memory. It is never sent to any server. When you close this tab, it's gone.
                    </div>
                </div>

                <form id="setup-form">
                    <div class="form-group">
                        <label class="form-label" for="full_name">Full Name *</label>
                        <input type="text" class="form-input" id="full_name" required
                            value="${esc(existing?.full_name || '')}"
                            placeholder="Jane Doe">
                    </div>

                    <div class="form-group">
                        <label class="form-label" for="email">Email Address *</label>
                        <input type="email" class="form-input" id="email" required
                            value="${esc(existing?.email || '')}"
                            placeholder="jane@example.com">
                    </div>

                    <div class="form-group">
                        <label class="form-label" for="location">Location *</label>
                        <select class="form-select" id="location" required>
                            <option value="">Select your state or region</option>
                            <optgroup label="United States">
                                ${US_STATES.map(s => `<option value="${s}" ${existing?.state === s ? 'selected' : ''}>${s}</option>`).join('')}
                            </optgroup>
                            <optgroup label="Europe / UK">
                                ${Object.entries(EU_COUNTRIES).map(([code, name]) =>
                                    `<option value="EU:${code}" ${existing?.country === code ? 'selected' : ''}>${name}</option>`
                                ).join('')}
                            </optgroup>
                            <option value="other">Other / Prefer not to say</option>
                        </select>
                        <div class="form-hint">Used to select the strongest legal template for your jurisdiction.</div>
                    </div>

                    <button type="submit" class="btn btn-primary btn-lg" style="width:100%">
                        Generate Opt-Out Emails
                    </button>

                    <details class="mt-2" style="cursor: pointer;">
                        <summary class="text-sm text-secondary">Optional: add more identifying info</summary>
                        <div class="callout mt-1" style="text-align: left; padding: 1rem;">
                            <p class="text-sm text-secondary" style="max-width: none;">
                                <strong>Less is more.</strong> Email is an open protocol — additional PII
                                (phone, address, DOB) in your opt-out email could expose data the broker
                                didn't already have. Name + email is legally sufficient for a deletion request.
                                Only add more if you want to help brokers match your specific records.
                            </p>
                        </div>
                        <div class="form-group mt-1">
                            <label class="form-label" for="email_aliases">Additional Email Addresses</label>
                            <textarea class="form-input" id="email_aliases" rows="2"
                                placeholder="One per line — e.g. alias@example.com">${esc((existing?.email_aliases || []).join('\n'))}</textarea>
                            <div class="form-hint">If you use different emails for different services, list them here so brokers can match all your records.</div>
                        </div>
                        <div class="form-row mt-1">
                            <div class="form-group">
                                <label class="form-label" for="phone">Phone</label>
                                <input type="tel" class="form-input" id="phone"
                                    value="${esc(existing?.phone || '')}"
                                    placeholder="Optional">
                            </div>
                            <div class="form-group">
                                <label class="form-label" for="dob">Date of Birth</label>
                                <input type="date" class="form-input" id="dob"
                                    value="${esc(existing?.dob || '')}">
                            </div>
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="street">Street Address</label>
                            <input type="text" class="form-input" id="street"
                                value="${esc(existing?.street || '')}">
                        </div>
                        <div class="form-row">
                            <div class="form-group">
                                <label class="form-label" for="city">City</label>
                                <input type="text" class="form-input" id="city"
                                    value="${esc(existing?.city || '')}">
                            </div>
                            <div class="form-group">
                                <label class="form-label" for="zip">ZIP / Postal Code</label>
                                <input type="text" class="form-input" id="zip"
                                    value="${esc(existing?.zip || '')}">
                            </div>
                        </div>
                    </details>
                </form>
            </div>
        </div>
    `;

    container.querySelector('#setup-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const locationVal = container.querySelector('#location').value;
        let state = '';
        let country = 'US';

        if (locationVal.startsWith('EU:')) {
            country = locationVal.slice(3);
            state = '';
        } else if (locationVal === 'other') {
            country = '';
            state = '';
        } else {
            state = locationVal;
            country = 'US';
        }

        const aliasText = container.querySelector('#email_aliases').value.trim();
        const email_aliases = aliasText
            ? aliasText.split(/[\n,]+/).map(e => e.trim()).filter(e => e)
            : [];

        Store.setPII({
            full_name: container.querySelector('#full_name').value.trim(),
            email: container.querySelector('#email').value.trim(),
            email_aliases,
            state,
            country,
            phone: container.querySelector('#phone').value.trim(),
            dob: container.querySelector('#dob').value,
            street: container.querySelector('#street').value.trim(),
            city: container.querySelector('#city').value.trim(),
            zip: container.querySelector('#zip').value.trim(),
        });

        location.hash = '#queue';
    });
}

function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// --- Boot ---

async function boot() {
    try {
        await Promise.all([
            Templates.load(),
            Queue.load(),
            Brokers.load(),
        ]);
    } catch (err) {
        console.error('Failed to load data:', err);
    }

    window.addEventListener('hashchange', route);
    route();
}

boot();
