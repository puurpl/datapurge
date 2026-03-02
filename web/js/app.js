/**
 * DataPurge App — Main entry point, router, view initialization
 */

import { Store } from './store.js';
import { Templates } from './templates.js';
import { Queue } from './queue.js';
import { Brokers } from './brokers.js';
import { Scan } from './scan.js';
import { Progress } from './progress.js';
import { Share } from './share.js';
import { isCapacitor, applyCapacitorUI, checkForUpdates, Notifier } from './capacitor-bridge.js';

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

let dataLoaded = false;

// --- Router ---

function getHash() {
    return (location.hash || '#setup').slice(1);
}

function route() {
    const hash = getHash();

    // Redirect to setup if PII required but missing
    if ((hash === 'queue' || hash === 'progress' || hash === 'scan') && !Store.hasPII()) {
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
        document.getElementById('view-setup').hidden = false;
        initView('setup', document.getElementById('view-setup'));
    }

    // Update nav
    document.querySelectorAll('.nav-tab').forEach(a => {
        a.classList.toggle('active', a.getAttribute('href') === `#${hash}`);
    });

    // Update profile switcher
    renderProfileSwitcher();
}

function initView(name, el) {
    switch (name) {
        case 'setup': renderSetup(el); break;
        case 'queue': Queue.render(el); break;
        case 'scan': Scan.render(el); break;
        case 'brokers': Brokers.render(el); break;
        case 'progress': Progress.render(el, Queue.getRegistryData()); break;
        case 'share': Share.render(el); break;
    }
}

// --- Profile Switcher (in nav) ---

function renderProfileSwitcher() {
    let switcher = document.getElementById('profile-switcher');
    if (!switcher) return;

    const profiles = Store.getProfiles();
    const activeId = Store.getActiveProfileId();

    if (profiles.length <= 1 && !Store.hasPII()) {
        switcher.innerHTML = '';
        return;
    }

    switcher.innerHTML = `
        <select id="profile-select" class="profile-select" title="Switch profile">
            ${profiles.map(p => `
                <option value="${esc(p.id)}" ${p.id === activeId ? 'selected' : ''}>
                    ${esc(p.label || 'Profile')}
                </option>
            `).join('')}
            <option value="__new__">+ New Profile</option>
        </select>
    `;

    switcher.querySelector('#profile-select').addEventListener('change', (e) => {
        if (e.target.value === '__new__') {
            location.hash = '#setup';
            // Clear active so setup shows a blank form
            Store.createProfile({
                full_name: '', email: '', state: '', country: '',
                phone: '', dob: '', street: '', city: '', zip: '',
            });
            route();
        } else {
            Store.switchProfile(e.target.value);
            route();
        }
    });
}

// --- Setup View ---

function renderSetup(container) {
    const existing = Store.getPII();
    const profiles = Store.getProfiles();
    const isEditing = existing && existing.full_name;

    container.innerHTML = `
        <div class="setup-page">
            <div class="container-narrow">
                <div class="setup-header">
                    <h2>${isEditing ? 'Edit Profile' : 'Create a Profile'}</h2>
                    <p class="text-secondary">
                        ${isEditing
                            ? 'Update your information for opt-out requests.'
                            : 'Enter your information to generate opt-out emails. You can create multiple profiles.'}
                    </p>
                </div>

                ${profiles.length > 1 ? `
                <div class="profile-list mb-2">
                    <h3 class="text-sm text-secondary mb-1">Your Profiles</h3>
                    ${profiles.map(p => `
                        <div class="profile-list-item ${p.id === Store.getActiveProfileId() ? 'active' : ''}">
                            <button class="profile-list-btn" data-profile-id="${esc(p.id)}">
                                <strong>${esc(p.label || 'Profile')}</strong>
                                <span class="text-sm text-muted">${esc(p.pii?.email || '')}</span>
                            </button>
                            <button class="btn btn-ghost btn-sm btn-delete-profile" data-profile-id="${esc(p.id)}" title="Delete profile">
                                &times;
                            </button>
                        </div>
                    `).join('')}
                    <button class="btn btn-outline btn-sm mt-1" id="btn-new-profile">+ New Profile</button>
                </div>
                ` : ''}

                <div class="privacy-notice">
                    <span class="privacy-notice-icon">&#128274;</span>
                    <div>
                        <strong>Privacy first.</strong> Your information is stored only in your browser's
                        local storage. It is never sent to any server. You can delete it at any time.
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
                        <label class="form-label" for="location">Location</label>
                        <select class="form-select" id="location">
                            <option value="">Select your state or region (optional)</option>
                            <optgroup label="United States">
                                ${US_STATES.map(s => `<option value="${s}" ${existing?.state === s ? 'selected' : ''}>${s}</option>`).join('')}
                            </optgroup>
                            <optgroup label="Europe / UK">
                                ${Object.entries(EU_COUNTRIES).map(([code, name]) =>
                                    `<option value="EU:${code}" ${existing?.country === code ? 'selected' : ''}>${name}</option>`
                                ).join('')}
                            </optgroup>
                            <option value="other" ${existing?.country === '' && existing?.state === '' && existing?.full_name ? 'selected' : ''}>Other / Prefer not to say</option>
                        </select>
                        <div class="form-hint">Used to select the strongest legal template for your jurisdiction. If not provided, we'll use a general template citing multiple laws.</div>
                    </div>

                    <button type="submit" class="btn btn-primary btn-lg" style="width:100%">
                        ${isEditing ? 'Update & Continue' : 'Generate Opt-Out Emails'}
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

    // Profile list interactions
    container.querySelectorAll('.profile-list-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            Store.switchProfile(btn.dataset.profileId);
            renderSetup(container);
        });
    });

    container.querySelectorAll('.btn-delete-profile').forEach(btn => {
        btn.addEventListener('click', () => {
            if (confirm('Delete this profile and all its progress?')) {
                Store.deleteProfile(btn.dataset.profileId);
                renderSetup(container);
            }
        });
    });

    const btnNew = container.querySelector('#btn-new-profile');
    if (btnNew) {
        btnNew.addEventListener('click', () => {
            Store.createProfile({
                full_name: '', email: '', state: '', country: '',
                phone: '', dob: '', street: '', city: '', zip: '',
            });
            renderSetup(container);
        });
    }

    // Form submission
    container.querySelector('#setup-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const locationVal = container.querySelector('#location').value;
        let state = '';
        let country = 'US';

        if (locationVal.startsWith('EU:')) {
            country = locationVal.slice(3);
            state = '';
        } else if (locationVal === 'other' || locationVal === '') {
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

// --- Error Banner ---

function showErrorBanner(message) {
    let banner = document.getElementById('error-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'error-banner';
        banner.className = 'error-banner';
        document.body.prepend(banner);
    }
    banner.innerHTML = `
        <span>${esc(message)}</span>
        <button onclick="this.parentElement.remove()" class="btn btn-ghost btn-sm">&times;</button>
    `;
}

// --- Boot ---

async function boot() {
    try {
        await Promise.all([
            Templates.load(),
            Queue.load(),
            Brokers.load(),
        ]);
        dataLoaded = true;
    } catch (err) {
        console.error('Failed to load data:', err);
        showErrorBanner('Some data failed to load. Parts of the app may not work correctly. Try reloading.');
    }

    // Register service worker for PWA (skip in native app)
    if ('serviceWorker' in navigator && !isCapacitor()) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    // Capacitor-specific initialization
    if (isCapacitor()) {
        applyCapacitorUI();
        await checkForUpdates();
        await Notifier.requestPermission();
    }

    // Cross-tab sync: re-render current view when another tab changes data
    window.addEventListener('datapurge-storage-sync', () => {
        route();
    });

    window.addEventListener('hashchange', route);
    route();
}

boot();
