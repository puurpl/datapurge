/**
 * DataPurge Letters - Printable postal opt-out letters (client-side only)
 *
 * A third queue mode. Brokers that cannot be reached by email (or any broker
 * with a mailing address on file) get a US business letter the user prints and
 * mails themselves. There is no mailing API: the browser lays out the letters,
 * the user signs and posts them. Letters reuse the same legal templates as the
 * email flow, so the wording is identical; only the channel changes.
 */

import { Store } from './store.js';
import { Templates } from './templates.js';
import { Relay } from './relay.js';
import { Queue } from './queue.js';

// USPS postage rates in USD, per letter. Update these when USPS raises rates.
//   FIRST_CLASS = current First-Class Mail letter (1 oz) stamp.
//   CERTIFIED   = approximate Certified Mail plus return receipt (green card) per piece.
const FIRST_CLASS_RATE = 0.73;
const CERTIFIED_RATE = 5.00;

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
    div.textContent = str == null ? '' : str;
    return div.innerHTML;
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
        .catch(() => showToast('Copy failed - try selecting the text manually'));
}

function catLabel(broker) {
    return CATEGORY_LABELS[broker.category] || broker.category || 'Other';
}

function byName(a, b) {
    return a.name.localeCompare(b.name);
}

// A usable postal method: a working (non-flagged) postal method with an address.
function getPostalMethod(broker) {
    const methods = (broker.optout && broker.optout.methods) || [];
    return methods.find(m => m.type === 'postal' && !m.status && m.postal_address) || null;
}

function getPostalAddress(broker) {
    const m = getPostalMethod(broker);
    return m ? m.postal_address : null;
}

function brokersWithAddress(registryData) {
    if (!registryData || !registryData.brokers) return [];
    return registryData.brokers.filter(b => !b.meta?.defunct && getPostalAddress(b));
}

// --- Letter assembly ---

// Sender block from the profile's mailing address, with a bracketed hint when
// the profile has no street address on file yet.
function senderBlock(pii) {
    const lines = [pii.full_name || '[Your full name]'];
    const cityLine = [pii.city, pii.state].filter(Boolean).join(', ');
    const cityStateZip = [cityLine, pii.zip].filter(Boolean).join(' ').trim();
    if (pii.street) lines.push(pii.street);
    if (cityStateZip) lines.push(cityStateZip);
    if (!pii.street && !cityStateZip) {
        lines.push('[Add your mailing address in your profile so it prints here]');
    }
    return lines.join('\n');
}

// Post-process the filled body to open a hand-signature gap: insert three blank
// lines just before the closing "{name}\nDate:" block. Works on the filled text
// (name and date already interpolated) so no template is edited. Skips silently
// when the pattern is absent or the name is empty.
function insertSignatureGap(body, fullName) {
    if (!fullName) return body;
    const marker = `\n${fullName}\nDate:`;
    const idx = body.lastIndexOf(marker);
    if (idx < 0) return body;
    return body.slice(0, idx) + '\n\n\n' + body.slice(idx);
}

// Build one US business letter as plain text. Returns null if the letter cannot
// be produced (no template, or no address). The body reuses the exact email
// template via selectBestTemplate + Templates.fill, unchanged.
function buildLetter(broker, pii, fields) {
    const address = getPostalAddress(broker);
    if (!address) return null;

    const templateId = Templates.selectBestTemplate(pii.state, pii.country, broker);
    const filled = Templates.fill(templateId, fields, broker);
    if (!filled) return null;

    const recipient = [broker.name];
    // "Attn:" only when the stored address does not already carry one.
    if (!/attn|attention/i.test(address)) {
        recipient.push('Attn: Privacy Officer or Legal Department');
    }
    // Postal address is printed verbatim - never comma-split into lines.
    recipient.push(address);

    const bodyWithGap = insertSignatureGap(filled.body, fields.full_name);

    const text = [
        senderBlock(pii),
        '',
        fields.date,
        '',
        recipient.join('\n'),
        '',
        `RE: ${filled.subject}`,
        '',
        bodyWithGap,
    ].join('\n');

    return { broker, address, templateId, subject: filled.subject, text };
}

// --- Print + download ---

function getPrintRoot() {
    let root = document.getElementById('letters-print-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'letters-print-root';
        document.body.appendChild(root);
    }
    return root;
}

function cleanupPrint() {
    document.body.classList.remove('printing-letters');
    const root = document.getElementById('letters-print-root');
    if (root) root.innerHTML = '';
}

function buildLetters(brokers, pii, fields) {
    return brokers.map(b => buildLetter(b, pii, fields)).filter(Boolean);
}

// Fill the hidden print root, isolate it for the print dialog, and print. The
// body class gates the @media print rules, so printing any other view is never
// hijacked by stale letter content. afterprint clears the isolation.
function printLetters(brokers, pii, fields) {
    const letters = buildLetters(brokers, pii, fields);
    if (!letters.length) return;
    const root = getPrintRoot();
    root.innerHTML = letters.map(l => `<div class="letter">${esc(l.text)}</div>`).join('');
    document.body.classList.add('printing-letters');
    const done = () => { cleanupPrint(); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
}

// Standalone .html fallback: a self-contained document with embedded print CSS.
// Doubles as a headless-verification artifact (one .letter per page).
function lettersHtmlDoc(letters) {
    const style = [
        '@page { size: Letter; margin: 1in; }',
        'html, body { margin: 0; padding: 0; background: #fff; }',
        '.letter {',
        "  font-family: Georgia, 'Times New Roman', serif;",
        '  font-size: 11pt; line-height: 1.45; color: #000;',
        '  white-space: pre-wrap; box-sizing: border-box; padding: 1in;',
        '  break-after: page; page-break-after: always;',
        '}',
        '.letter:last-child { break-after: auto; page-break-after: auto; }',
        '@media print { .letter { padding: 0; } }',
    ].join('\n');
    const pages = letters.map(l => `<div class="letter">${esc(l.text)}</div>`).join('\n');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DataPurge opt-out letters</title>
<style>
${style}
</style>
</head>
<body>
${pages}
</body>
</html>`;
}

function downloadLetters(brokers, pii, fields) {
    const letters = buildLetters(brokers, pii, fields);
    if (!letters.length) return;
    const blob = new Blob([lettersHtmlDoc(letters)], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `datapurge-letters-${new Date().toISOString().slice(0, 10)}.html`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`${letters.length} letter${letters.length !== 1 ? 's' : ''} downloaded as HTML`);
}

// --- Scope + selection ---

// Raw candidate set for a scope (before address / preference filtering).
function scopeCandidates(scope, registryData) {
    if (scope === 'all') return brokersWithAddress(registryData);
    // Default: brokers the email queue cannot reach, via the queue.js accessor.
    return Queue.getNonEmailBrokers() || [];
}

function isIncluded(broker, baseIds, prefs) {
    const pref = prefs[broker.id];
    if (pref === 'include') return true;
    if (pref === 'exclude') return false;
    return baseIds.has(broker.id);
}

// Resolve the current scope into printable letters, editable rows, and the
// honest "no address on file" list.
function resolveSelection(scope, registryData) {
    const prefs = Store.getLetterPrefs();
    const candidates = scopeCandidates(scope, registryData);
    const baseIds = new Set(candidates.map(b => b.id));
    const all = brokersWithAddress(registryData);

    const printable = all.filter(b => isIncluded(b, baseIds, prefs)).sort(byName);
    const noAddress = candidates.filter(b => !getPostalAddress(b)).sort(byName);
    const rows = all
        .filter(b => baseIds.has(b.id) || prefs[b.id] === 'include' || prefs[b.id] === 'exclude')
        .sort(byName);

    return { printable, noAddress, rows, baseIds, prefs };
}

function searchAddable(registryData, term, alreadyIds) {
    const q = term.trim().toLowerCase();
    if (!q) return [];
    return brokersWithAddress(registryData)
        .filter(b => !alreadyIds.has(b.id))
        .filter(b => b.name.toLowerCase().includes(q) || (b.domain || '').toLowerCase().includes(q))
        .sort(byName)
        .slice(0, 8);
}

// --- Rendering pieces ---

function guidanceHtml() {
    const relayActive = Relay.isActive();
    const alias = relayActive ? Relay.getActiveAlias() : null;
    return `
        <div class="callout" style="text-align: left;">
            <h3 style="margin-bottom: 0.5rem;">How to send these letters</h3>
            <p class="text-secondary" style="max-width: none;">
                Print each letter, sign it by hand in the gap above your name, and mail it.
                First-class postage works, but <strong>certified mail with return receipt</strong>
                is stronger: the return receipt is dated proof the broker received your request,
                which starts their legal response clock. Keep each receipt with your opt-out log
                so you have a paper trail if you need to escalate later.
            </p>
            ${relayActive && alias ? `
            <p class="text-sm text-secondary mt-1" style="max-width: none;">
                Your Reply Mailbox is active, so the contact email printed in these letters is your
                alias <code>${esc(alias)}</code>. Any written response a broker emails you lands in
                your alias instead of your personal inbox.
            </p>
            ` : ''}
        </div>
    `;
}

function letterRowHtml(broker, pii, fields, { showCheckbox, included, mailed }) {
    const built = buildLetter(broker, pii, fields);
    const previewText = built ? built.text : '(letter unavailable)';
    const address = getPostalAddress(broker) || '';
    const id = esc(broker.id);
    const checkbox = showCheckbox
        ? `<input type="checkbox" class="letter-row-check" data-broker-id="${id}" ${included ? 'checked' : ''} style="margin-right: 0.5rem;">`
        : '';
    return `
        <div class="card mt-1" data-letter-row="${id}">
            <div class="flex items-center justify-between" style="gap: 0.5rem;">
                <label style="display: flex; align-items: center; cursor: ${showCheckbox ? 'pointer' : 'default'};">
                    ${checkbox}
                    <span class="queue-item-name">${esc(broker.name)}</span>
                    <span class="badge badge-category" style="margin-left: 0.5rem;">${esc(catLabel(broker))}</span>
                    ${mailed ? '<span class="badge badge-category" style="margin-left: 0.375rem;">Mailed</span>' : ''}
                </label>
                <button class="btn btn-outline btn-sm btn-copy-address" data-broker-id="${id}">Copy address</button>
            </div>
            <div class="text-sm text-muted mt-1">${esc(address)}</div>
            <div class="email-preview" style="margin-top: 0.75rem;">
                <button class="email-preview-toggle" data-preview-broker="${id}">
                    <span>Preview letter</span>
                    <span>&#9662;</span>
                </button>
                <div class="email-preview-content" data-preview-content="${id}">${esc(previewText)}</div>
            </div>
        </div>
    `;
}

export const Letters = {
    // Exposed for headless verification and reuse.
    buildLetter,

    // Third queue mode. opts.focusBrokerId scopes the view to a single broker
    // (used by the "Print letter" action in the manual opt-out list).
    render(container, registryData, opts = {}) {
        const focusId = opts.focusBrokerId || null;
        const pii = Store.getPII();
        const fields = Store.getTemplateFields();

        if (!pii || !fields) {
            container.innerHTML = `
                <div class="flex items-center justify-between mb-2">
                    <h2>Printable Letters</h2>
                    <button class="btn btn-outline btn-sm" id="btn-letters-back">Back to Mass Send</button>
                </div>
                <div class="empty-state">
                    <h3>Add your details first</h3>
                    <p>We need your name and mailing address to write the letters. Set up your profile, then come back.</p>
                    <a href="#setup" class="btn btn-primary mt-2">Go to profile setup</a>
                </div>`;
            const back = container.querySelector('#btn-letters-back');
            if (back) back.addEventListener('click', () => Queue.render(container));
            return;
        }

        let scope = 'unreachable';
        const hasAddr = !!(pii.street || pii.city || pii.zip);

        const rerender = () => {
            let printable, noAddress, rows;
            if (focusId) {
                const b = (registryData.brokers || []).find(x => x.id === focusId);
                printable = (b && getPostalAddress(b)) ? [b] : [];
                noAddress = [];
                rows = [];
            } else {
                const sel = resolveSelection(scope, registryData);
                printable = sel.printable;
                noAddress = sel.noAddress;
                rows = sel.rows;
            }

            const n = printable.length;
            const noun = n === 1 ? 'letter' : 'letters';
            const firstClass = (n * FIRST_CLASS_RATE).toFixed(2);
            const certified = (n * CERTIFIED_RATE).toFixed(2);
            const prefs = Store.getLetterPrefs();
            const baseIds = focusId ? new Set() : new Set(scopeCandidates(scope, registryData).map(b => b.id));

            container.innerHTML = `
                <div class="flex items-center justify-between mb-2">
                    <h2>Printable Letters</h2>
                    <button class="btn btn-outline btn-sm" id="btn-letters-back">Back to Mass Send</button>
                </div>

                <div class="callout" style="text-align: left;">
                    <p class="text-secondary" style="max-width: none;">
                        Some brokers only accept opt-out requests by post, and mailed requests build the
                        strongest paper trail. These letters use the same legal templates as the email
                        queue - your browser lays them out, you sign and mail them. Nothing is sent for you.
                    </p>
                </div>

                ${!hasAddr ? `
                <div class="callout callout-action mt-2" style="text-align: left;">
                    <h3 style="margin-bottom: 0.5rem;">Add your mailing address</h3>
                    <p class="text-secondary" style="max-width: none;">
                        Your profile has no street address on file, so the sender block prints a placeholder.
                        Add your street, city, state and ZIP in your <a href="#setup">profile</a> so it appears
                        on every letter. You can still print now and write your return address by hand.
                    </p>
                </div>
                ` : ''}

                ${focusId ? `
                <div class="card mt-2">
                    <p class="text-sm text-secondary">
                        Printing one letter${printable.length ? ` for <strong>${esc(printable[0].name)}</strong>` : ''}.
                        <button class="btn-link text-sm" id="btn-letters-showall" style="background:none; border:none; color:var(--color-primary); cursor:pointer; padding:0; text-decoration:underline;">Show all printable letters</button>
                    </p>
                </div>
                ` : `
                <div class="card mt-2">
                    <div class="card-header"><div class="card-title">Which brokers?</div></div>
                    <label style="display: flex; align-items: flex-start; gap: 0.5rem; cursor: pointer; margin-bottom: 0.5rem;">
                        <input type="radio" name="letters-scope" value="unreachable" ${scope === 'unreachable' ? 'checked' : ''} style="margin-top: 0.2rem;">
                        <span><strong>Brokers unreachable by email (recommended)</strong>
                            <span class="text-sm text-secondary" style="display: block;">The brokers the email queue cannot reach. Only those with a mailing address on file get a letter.</span>
                        </span>
                    </label>
                    <label style="display: flex; align-items: flex-start; gap: 0.5rem; cursor: pointer;">
                        <input type="radio" name="letters-scope" value="all" ${scope === 'all' ? 'checked' : ''} style="margin-top: 0.2rem;">
                        <span><strong>All brokers with a mailing address</strong>
                            <span class="text-sm text-secondary" style="display: block;">Every broker we hold a postal address for, whether or not email also works.</span>
                        </span>
                    </label>
                </div>
                `}

                <div class="card mt-2">
                    ${n > 0
                        ? `<p class="text-secondary" style="max-width: none;">
                               <strong>${n} ${noun}</strong>, about <strong>$${firstClass}</strong> first-class
                               or <strong>$${certified}</strong> certified with return receipt.
                           </p>`
                        : `<p class="text-secondary" style="max-width: none;">
                               No letters to print in this scope yet. ${focusId ? '' : "Switch scope, or add a broker with a mailing address using the search below."}
                           </p>`}
                    <div class="btn-group mt-1" style="flex-wrap: wrap; gap: 0.5rem;">
                        <button class="btn btn-primary" id="btn-print-letters" ${n === 0 ? 'disabled' : ''}>Print ${n} ${noun}</button>
                        <button class="btn btn-outline" id="btn-download-letters" ${n === 0 ? 'disabled' : ''}>Download letters (.html)</button>
                        <button class="btn btn-success" id="btn-mark-mailed" ${n === 0 ? 'disabled' : ''}>Mark ${n} ${noun} as mailed</button>
                    </div>
                </div>

                ${guidanceHtml()}

                ${focusId
                    ? (printable.length
                        ? letterRowHtml(printable[0], pii, fields, { showCheckbox: false, included: true, mailed: Store.isSent(printable[0].id) })
                        : `<div class="empty-state mt-2"><h3>No mailing address on file</h3><p>We do not have a postal address for this broker yet, so no letter can be printed.</p></div>`)
                    : `
                    <div class="mt-3">
                        <h3 class="queue-list-header">Letters to print (${rows.filter(b => isIncluded(b, baseIds, prefs)).length} of ${rows.length})</h3>
                        ${rows.length
                            ? rows.map(b => letterRowHtml(b, pii, fields, {
                                showCheckbox: true,
                                included: isIncluded(b, baseIds, prefs),
                                mailed: Store.isSent(b.id),
                            })).join('')
                            : '<p class="text-muted mt-1">No brokers with a mailing address in this scope. Use the search below to add one.</p>'}
                    </div>

                    <div class="card mt-2">
                        <label class="form-label" for="letters-search">Add another broker with a mailing address</label>
                        <input type="text" id="letters-search" class="form-input" placeholder="Search by name or domain..." autocomplete="off">
                        <div id="letters-search-results" class="mt-1"></div>
                    </div>

                    ${noAddress.length ? `
                    <details class="callout mt-2" style="text-align: left;">
                        <summary class="text-sm text-secondary" style="cursor: pointer;">
                            <strong>No mailing address on file (${noAddress.length})</strong> - show the list.
                        </summary>
                        <div class="mt-1">
                            <p class="text-sm text-secondary" style="max-width: none;">
                                We do not have a verified postal address for these brokers yet, so no letter can be
                                printed for them. They are reachable only by web form or phone - use the manual
                                opt-out list on the Queue for those. As we verify more addresses, they will move
                                into the printable list above.
                            </p>
                            ${noAddress.map(b => `
                                <div class="queue-item">
                                    <span class="queue-item-name">${esc(b.name)}</span>
                                    <span class="badge badge-category" style="margin-left: 0.5rem;">${esc(catLabel(b))}</span>
                                </div>
                            `).join('')}
                        </div>
                    </details>
                    ` : ''}
                    `}
            `;

            // --- Listeners ---

            container.querySelector('#btn-letters-back').addEventListener('click', () => Queue.render(container));

            const showAll = container.querySelector('#btn-letters-showall');
            if (showAll) showAll.addEventListener('click', () => Letters.render(container, registryData));

            container.querySelectorAll('input[name="letters-scope"]').forEach(radio => {
                radio.addEventListener('change', () => {
                    if (radio.checked) { scope = radio.value; rerender(); }
                });
            });

            const printBtn = container.querySelector('#btn-print-letters');
            if (printBtn) printBtn.addEventListener('click', () => printLetters(printable, pii, fields));

            const downloadBtn = container.querySelector('#btn-download-letters');
            if (downloadBtn) downloadBtn.addEventListener('click', () => downloadLetters(printable, pii, fields));

            const markBtn = container.querySelector('#btn-mark-mailed');
            if (markBtn) markBtn.addEventListener('click', () => {
                if (!printable.length) return;
                if (!confirm(`Mark ${printable.length} ${noun} as mailed? Do this only after you post them.`)) return;
                printable.forEach(b => Store.markSent(b.id, { sentVia: 'letter' }));
                showToast(`${printable.length} ${noun} marked as mailed`);
                rerender();
            });

            container.querySelectorAll('.btn-copy-address').forEach(btn => {
                btn.addEventListener('click', () => {
                    const id = btn.getAttribute('data-broker-id');
                    const broker = (registryData.brokers || []).find(b => b.id === id);
                    const addr = broker ? getPostalAddress(broker) : null;
                    if (addr) copyToClipboard(addr, 'Mailing address copied');
                });
            });

            container.querySelectorAll('[data-preview-broker]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const id = btn.getAttribute('data-preview-broker');
                    const panel = container.querySelector(`[data-preview-content="${CSS.escape(id)}"]`);
                    if (panel) panel.classList.toggle('open');
                });
            });

            container.querySelectorAll('.letter-row-check').forEach(cb => {
                cb.addEventListener('change', () => {
                    const id = cb.getAttribute('data-broker-id');
                    Store.setLetterPref(id, cb.checked ? 'include' : 'exclude');
                    rerender();
                });
            });

            const searchInput = container.querySelector('#letters-search');
            const resultsEl = container.querySelector('#letters-search-results');
            if (searchInput && resultsEl) {
                searchInput.addEventListener('input', () => {
                    const alreadyIds = new Set(rows.map(b => b.id));
                    const matches = searchAddable(registryData, searchInput.value, alreadyIds);
                    if (!searchInput.value.trim()) { resultsEl.innerHTML = ''; return; }
                    if (!matches.length) {
                        resultsEl.innerHTML = '<p class="text-sm text-muted">No matching broker with a mailing address on file.</p>';
                        return;
                    }
                    resultsEl.innerHTML = matches.map(b => `
                        <div class="queue-item">
                            <div>
                                <span class="queue-item-name">${esc(b.name)}</span>
                                <span class="text-muted text-sm"> &middot; ${esc(b.domain || '')}</span>
                            </div>
                            <button class="btn btn-outline btn-sm btn-add-letter" data-broker-id="${esc(b.id)}">Add</button>
                        </div>
                    `).join('');
                    resultsEl.querySelectorAll('.btn-add-letter').forEach(btn => {
                        btn.addEventListener('click', () => {
                            Store.setLetterPref(btn.getAttribute('data-broker-id'), 'include');
                            rerender();
                        });
                    });
                });
            }
        };

        rerender();
    },
};
