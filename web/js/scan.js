/**
 * DataPurge Scan — Search for your data on broker sites
 *
 * Shows scannable brokers with personalized search links
 * built from the user's profile (first_name, last_name, state).
 */

import { Store } from './store.js';
import { Queue } from './queue.js';

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
    'other': 'Other',
};

function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function buildSearchUrl(template, pii) {
    return template
        .replace(/\{first_name\}/g, encodeURIComponent(pii.first_name || ''))
        .replace(/\{last_name\}/g, encodeURIComponent(pii.last_name || ''))
        .replace(/\{full_name\}/g, encodeURIComponent(pii.full_name || ''))
        .replace(/\{state\}/g, encodeURIComponent(pii.state || ''))
        .replace(/\{city\}/g, encodeURIComponent(pii.city || ''))
        .replace(/\{zip\}/g, encodeURIComponent(pii.zip || ''))
        .replace(/\{email\}/g, encodeURIComponent(pii.email || ''));
}

function getScannableBrokers() {
    const reg = Queue.getRegistryData();
    if (!reg || !reg.brokers) return [];
    return reg.brokers.filter(b => b.scan && b.scan.scannable && b.scan.search_url);
}

function render(container) {
    const pii = Store.getPII();

    if (!pii || !pii.full_name) {
        container.innerHTML = `
            <div class="section-header">
                <h2>Find Your Data</h2>
                <p class="text-secondary">See which brokers have your personal information.</p>
            </div>
            <div class="empty-state">
                <h3>Create a profile first</h3>
                <p>We need your name to generate personalized search links for each broker.</p>
                <a href="#setup" class="btn btn-primary mt-2">Set Up Profile</a>
            </div>`;
        return;
    }

    const brokers = getScannableBrokers();

    if (brokers.length === 0) {
        container.innerHTML = `
            <div class="section-header">
                <h2>Find Your Data</h2>
            </div>
            <div class="empty-state">
                <h3>No scannable brokers loaded</h3>
                <p>Try reloading the page.</p>
            </div>`;
        return;
    }

    const categories = [...new Set(brokers.map(b => b.category).filter(Boolean))].sort();
    const progress = Store.getProgress();

    container.innerHTML = `
        <div class="section-header">
            <h2>Find Your Data</h2>
            <p class="text-secondary">
                ${brokers.length} brokers have public search pages. Click to check if <strong>${esc(pii.full_name)}</strong> appears in their records, then send an opt-out if found.
            </p>
        </div>

        <div class="privacy-notice mb-2">
            <span class="privacy-notice-icon">&#128270;</span>
            <div>
                <strong>How this works:</strong> Each link opens the broker's own public search page
                with your name pre-filled. Your data stays in your browser — we just build the URL.
            </div>
        </div>

        <div class="search-bar">
            <input type="text" class="form-input" id="scan-search" placeholder="Filter brokers..." autocomplete="off">
            <select class="form-select" id="scan-category">
                <option value="">All categories</option>
                ${categories.map(c => `<option value="${esc(c)}">${esc(CATEGORY_LABELS[c] || c)}</option>`).join('')}
            </select>
        </div>

        <div class="flex justify-between items-center mb-1">
            <span class="text-sm text-secondary" id="scan-count">${brokers.length} searchable brokers</span>
        </div>

        <div class="broker-grid" id="scan-list"></div>
    `;

    const searchInput = container.querySelector('#scan-search');
    const categoryFilter = container.querySelector('#scan-category');
    const listEl = container.querySelector('#scan-list');
    const countLabel = container.querySelector('#scan-count');

    function filterAndRender() {
        const query = searchInput.value.trim().toLowerCase();
        const cat = categoryFilter.value;

        let filtered = brokers;
        if (query) {
            filtered = filtered.filter(b =>
                b.name.toLowerCase().includes(query) ||
                (b.domain && b.domain.toLowerCase().includes(query))
            );
        }
        if (cat) {
            filtered = filtered.filter(b => b.category === cat);
        }

        filtered.sort((a, b) => a.name.localeCompare(b.name));
        countLabel.textContent = `${filtered.length} searchable broker${filtered.length !== 1 ? 's' : ''}`;

        listEl.innerHTML = filtered.map(broker => {
            const searchUrl = buildSearchUrl(broker.scan.search_url, pii);
            const catLabel = CATEGORY_LABELS[broker.category] || broker.category || '';
            const sent = progress[broker.id];
            const dataTypes = (broker.data_types || []).slice(0, 6);

            const emailMethod = broker.optout?.methods?.find(m => m.type === 'email');

            return `
            <div class="card scan-card ${sent ? 'scan-card-sent' : ''}">
                <div class="broker-card-header">
                    <div>
                        <div class="broker-card-title">${esc(broker.name)}</div>
                        ${broker.domain ? `<div class="broker-card-domain">${esc(broker.domain)}</div>` : ''}
                    </div>
                    <span class="badge">${esc(catLabel)}</span>
                </div>
                ${dataTypes.length > 0 ? `
                <div class="tag-list mt-1" style="gap:0.25rem;">
                    ${dataTypes.map(t => `<span class="tag text-sm">${esc(t.replace(/-/g, ' '))}</span>`).join('')}
                </div>` : ''}
                <div class="scan-card-actions mt-1">
                    <a href="${esc(searchUrl)}" target="_blank" rel="noopener" class="btn btn-primary btn-sm">Search for My Data</a>
                    ${emailMethod ? `<a href="#queue" class="btn btn-outline btn-sm">Send Opt-Out</a>` : ''}
                    ${sent ? '<span class="badge badge-success">Opt-out sent</span>' : ''}
                </div>
            </div>`;
        }).join('');
    }

    let debounceTimer = null;
    searchInput.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(filterAndRender, 200);
    });
    categoryFilter.addEventListener('change', filterAndRender);

    filterAndRender();
}

export const Scan = { render };
