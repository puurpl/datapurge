/**
 * DataPurge Brokers — Directory search & display
 */

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
            b.domain.toLowerCase().includes(q) ||
            (b.aliases || []).some(a => a.toLowerCase().includes(q))
        );
    }
    if (category) {
        results = results.filter(b => b.category === category);
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
}

function getMethodTypes(broker) {
    if (!broker.optout || !broker.optout.methods) return [];
    return broker.optout.methods.map(m => m.type);
}

function renderBrokerCard(broker) {
    const difficulty = broker.optout?.difficulty || 'unknown';
    const methods = getMethodTypes(broker);
    const confidence = broker.meta?.confidence ? Math.round(broker.meta.confidence * 100) : null;
    const verified = broker.meta?.last_verified || null;

    return `
        <div class="card card-hover broker-card" data-broker-id="${esc(broker.id)}">
            <div class="broker-card-header">
                <div>
                    <div class="broker-card-title">${esc(broker.name)}</div>
                    <div class="broker-card-domain">${esc(broker.domain)}</div>
                </div>
                <div class="flex gap-1">
                    <span class="badge badge-category">${esc(CATEGORY_LABELS[broker.category] || broker.category)}</span>
                    <span class="badge badge-${difficulty}">${esc(difficulty)}</span>
                </div>
            </div>
            ${broker.data_types && broker.data_types.length
                ? `<div class="tag-list">${broker.data_types.slice(0, 8).map(t => `<span class="tag">${esc(t)}</span>`).join('')}${broker.data_types.length > 8 ? `<span class="tag">+${broker.data_types.length - 8} more</span>` : ''}</div>`
                : ''}
            <div class="broker-methods mt-1">
                ${methods.map(m => `<span class="method-icon">${methodIcon(m)} ${esc(m)}</span>`).join('')}
            </div>
            <div class="broker-card-details" id="details-${esc(broker.id)}">
                <div class="text-sm">
                    ${confidence !== null ? `<p><strong>Confidence:</strong> ${confidence}%</p>` : ''}
                    ${verified ? `<p><strong>Last verified:</strong> ${esc(verified)}</p>` : ''}
                    ${broker.legal?.ccpa ? '<p><strong>CCPA:</strong> Applicable</p>' : ''}
                    ${broker.legal?.gdpr ? '<p><strong>GDPR:</strong> Applicable</p>' : ''}
                    ${broker.timing?.typical_removal_days ? `<p><strong>Typical removal:</strong> ${broker.timing.typical_removal_days} days</p>` : ''}
                    ${broker.timing?.relisting_likelihood ? `<p><strong>Re-listing risk:</strong> ${esc(broker.timing.relisting_likelihood)}</p>` : ''}
                    ${broker.optout?.methods ? broker.optout.methods.map(m => {
                        if (m.type === 'email') return `<p><strong>Email:</strong> <a href="mailto:${esc(m.email_to)}">${esc(m.email_to)}</a></p>`;
                        if (m.type === 'web_form') return `<p><strong>Web form:</strong> <a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.url)}</a></p>`;
                        return '';
                    }).join('') : ''}
                    ${broker.meta?.notes ? `<p class="mt-1 text-muted">${esc(broker.meta.notes)}</p>` : ''}
                </div>
            </div>
        </div>
    `;
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

export const Brokers = {
    async load() {
        const resp = await fetch('data/registry.json');
        if (!resp.ok) throw new Error(`Failed to load broker directory: ${resp.status}`);
        const data = await resp.json();
        allBrokers = data.brokers || [];
    },

    render(container) {
        if (allBrokers.length === 0) {
            container.innerHTML = `
                <h2 class="mb-2">Broker Directory</h2>
                <div class="empty-state">
                    <h3>Unable to load broker data</h3>
                    <p>Please check your connection and reload the page.</p>
                    <button class="btn btn-outline mt-2" onclick="location.reload()">Reload</button>
                </div>`;
            return;
        }

        // Get unique categories
        const categories = [...new Set(allBrokers.map(b => b.category))].sort();

        container.innerHTML = `
            <h2 class="mb-2">Broker Directory</h2>
            <div class="search-bar">
                <input type="text" class="form-input" id="broker-search" placeholder="Search brokers...">
                <select class="form-select" id="broker-category">
                    <option value="">All categories</option>
                    ${categories.map(c => `<option value="${c}">${esc(CATEGORY_LABELS[c] || c)}</option>`).join('')}
                </select>
            </div>
            <div class="text-sm text-muted mb-2" id="broker-count">${allBrokers.length} brokers</div>
            <div class="broker-grid" id="broker-grid"></div>
        `;

        const searchInput = container.querySelector('#broker-search');
        const categorySelect = container.querySelector('#broker-category');
        const grid = container.querySelector('#broker-grid');
        const countEl = container.querySelector('#broker-count');

        const update = () => {
            const search = searchInput.value;
            const category = categorySelect.value;
            const results = filterBrokers({ search, category });
            countEl.textContent = `${results.length} broker${results.length !== 1 ? 's' : ''}`;
            grid.innerHTML = results.map(renderBrokerCard).join('');

            // Toggle details on click
            grid.querySelectorAll('.broker-card').forEach(card => {
                card.addEventListener('click', () => {
                    const id = card.dataset.brokerId;
                    const details = card.querySelector(`#details-${id}`);
                    if (details) details.classList.toggle('open');
                });
            });
        };

        searchInput.addEventListener('input', update);
        categorySelect.addEventListener('change', update);
        update();
    },
};
