/**
 * DataPurge Brokers — Searchable broker directory
 */

import { isCapacitor, RegistryUpdater } from './capacitor-bridge.js';

let allBrokers = [];

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

function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function filterBrokers({ search, category }) {
    let results = [...allBrokers];
    if (search) {
        const q = search.toLowerCase();
        results = results.filter(b =>
            b.name.toLowerCase().includes(q) ||
            (b.domain && b.domain.toLowerCase().includes(q)) ||
            (b.aliases || []).some(a => a.toLowerCase().includes(q))
        );
    }
    if (category) {
        results = results.filter(b => b.category === category);
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
}

function methodIcon(type) {
    switch (type) {
        case 'email': return '&#9993;';
        case 'web_form': return '&#127760;';
        case 'postal': return '&#9993;';
        case 'phone': return '&#9742;';
        default: return '&#8226;';
    }
}

function getMethodTypes(broker) {
    if (!broker.optout || !broker.optout.methods) return [];
    return broker.optout.methods.map(m => m.type);
}

function renderBrokerCard(broker) {
    const difficulty = broker.optout?.difficulty || 'unknown';
    const methods = getMethodTypes(broker);
    const catLabel = CATEGORY_LABELS[broker.category] || broker.category || 'Unknown';

    return `
        <div class="card broker-card" data-broker-id="${esc(broker.id)}" style="cursor:pointer;">
            <div class="broker-card-header">
                <div>
                    <div class="broker-card-title">${esc(broker.name)}</div>
                    ${broker.domain ? `<div class="broker-card-domain">${esc(broker.domain)}</div>` : ''}
                </div>
                <div class="flex gap-1">
                    <span class="badge">${esc(catLabel)}</span>
                    <span class="badge badge-${difficulty === 'easy' ? 'success' : difficulty === 'hard' || difficulty === 'very_hard' ? 'overdue' : 'secondary'}">${esc(difficulty)}</span>
                </div>
            </div>
            <div class="broker-methods">
                ${methods.map(m => `<span class="method-icon">${methodIcon(m)} ${esc(m)}</span>`).join('')}
            </div>
            <div class="broker-card-details" id="details-${esc(broker.id)}">
                <div class="text-sm">
                    ${broker.data_types && broker.data_types.length
                        ? `<p><strong>Data collected:</strong></p>
                           <div class="tag-list mb-1" style="gap:0.375rem;">${broker.data_types.slice(0, 12).map(t => `<span class="tag">${esc(t.replace(/-/g, ' '))}</span>`).join('')}${broker.data_types.length > 12 ? `<span class="tag">+${broker.data_types.length - 12}</span>` : ''}</div>`
                        : ''}
                    ${(broker.aliases || []).length > 0
                        ? `<p><strong>Also known as:</strong> ${broker.aliases.map(a => esc(a)).join(', ')}</p>`
                        : ''}
                    ${broker.legal?.ccpa ? '<p><strong>CCPA:</strong> Applicable</p>' : ''}
                    ${broker.legal?.gdpr ? '<p><strong>GDPR:</strong> Applicable</p>' : ''}
                    ${broker.optout?.legal_max_days ? `<p><strong>Legal deadline:</strong> ${broker.optout.legal_max_days} days</p>` : ''}
                    ${broker.timing?.typical_removal_days ? `<p><strong>Typical removal:</strong> ${broker.timing.typical_removal_days} days</p>` : ''}
                    ${broker.optout?.methods ? broker.optout.methods.map(m => {
                        if (m.type === 'email') return `<p><strong>Email:</strong> <a href="mailto:${esc(m.email_to)}">${esc(m.email_to)}</a></p>`;
                        if (m.type === 'web_form') return `<p><strong>Web form:</strong> <a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.url)}</a></p>`;
                        return '';
                    }).join('') : ''}
                    ${broker.optout?.notes ? `<p class="mt-1 text-muted">${esc(broker.optout.notes)}</p>` : ''}
                </div>
            </div>
        </div>
    `;
}

export const Brokers = {
    async load() {
        if (isCapacitor()) {
            const cached = RegistryUpdater.getCachedRegistry();
            if (cached) { allBrokers = cached.brokers || []; return; }
        }
        const resp = await fetch('data/registry.json');
        if (!resp.ok) throw new Error(`Failed to load broker directory: ${resp.status}`);
        const data = await resp.json();
        allBrokers = data.brokers || [];
    },

    render(container) {
        if (allBrokers.length === 0) {
            container.innerHTML = `
                <div class="section-header">
                    <h2>Data Broker Directory</h2>
                </div>
                <div class="empty-state">
                    <h3>Unable to load broker data</h3>
                    <p>Please check your connection and reload the page.</p>
                    <button class="btn btn-outline mt-2" onclick="location.reload()">Reload</button>
                </div>`;
            return;
        }

        const categories = [...new Set(allBrokers.map(b => b.category).filter(Boolean))].sort();

        container.innerHTML = `
            <div class="section-header">
                <h2>Data Broker Directory</h2>
                <p class="text-secondary">${allBrokers.length} brokers tracked. Search by name or domain, filter by category. Click a broker for details.</p>
            </div>
            <div class="search-bar">
                <input type="text" class="form-input" id="broker-search" placeholder="Search brokers by name or domain..." autocomplete="off">
                <select class="form-select" id="broker-category">
                    <option value="">All categories</option>
                    ${categories.map(c => `<option value="${c}">${esc(CATEGORY_LABELS[c] || c)}</option>`).join('')}
                </select>
            </div>
            <div class="flex justify-between items-center mb-1">
                <span class="text-sm text-secondary" id="broker-count">${allBrokers.length} brokers</span>
            </div>
            <div class="broker-grid" id="broker-grid"></div>
        `;

        const searchInput = container.querySelector('#broker-search');
        const categorySelect = container.querySelector('#broker-category');
        const grid = container.querySelector('#broker-grid');
        const countEl = container.querySelector('#broker-count');

        const CHUNK = 50;
        let expandedId = null;

        function attachCardListeners() {
            grid.querySelectorAll('.broker-card').forEach(card => {
                card.addEventListener('click', (e) => {
                    if (e.target.closest('a')) return;
                    const id = card.dataset.brokerId;
                    const details = card.querySelector('.broker-card-details');
                    if (!details) return;

                    if (details.classList.contains('open')) {
                        details.classList.remove('open');
                        expandedId = null;
                    } else {
                        grid.querySelectorAll('.broker-card-details.open').forEach(d => d.classList.remove('open'));
                        details.classList.add('open');
                        expandedId = id;
                    }
                });
            });
        }

        function renderResults() {
            const search = searchInput.value.trim();
            const category = categorySelect.value;
            const results = filterBrokers({ search, category });
            countEl.textContent = `${results.length} broker${results.length !== 1 ? 's' : ''}`;

            const visible = results.slice(0, CHUNK);
            let loadedCount = CHUNK;

            grid.innerHTML = visible.map(renderBrokerCard).join('');

            if (results.length > CHUNK) {
                addLoadMore(results, loadedCount);
            }

            attachCardListeners();

            if (expandedId) {
                const details = grid.querySelector(`#details-${expandedId}`);
                if (details) details.classList.add('open');
            }
        }

        function addLoadMore(results, loaded) {
            const btn = document.createElement('button');
            btn.className = 'btn btn-outline';
            btn.style.cssText = 'width:100%;margin-top:1rem;';
            btn.textContent = `Show more (${results.length - loaded} remaining)`;
            grid.appendChild(btn);

            btn.addEventListener('click', () => {
                btn.remove();
                const next = results.slice(loaded, loaded + CHUNK);
                loaded += CHUNK;

                const temp = document.createElement('div');
                temp.innerHTML = next.map(renderBrokerCard).join('');
                while (temp.firstChild) grid.appendChild(temp.firstChild);

                if (loaded < results.length) {
                    addLoadMore(results, loaded);
                }

                attachCardListeners();
            });
        }

        let debounceTimer = null;
        searchInput.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(renderResults, 200);
        });
        categorySelect.addEventListener('change', renderResults);

        renderResults();
    },
};
