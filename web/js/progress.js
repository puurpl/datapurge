/**
 * DataPurge Progress — Monitoring pipeline, deadline tracking, verification
 */

import { Store } from './store.js';
import { Templates } from './templates.js';

function esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
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

function daysBetween(d1, d2) {
    return Math.floor((d2 - d1) / 86400000);
}

function getSearchUrl(broker) {
    if (!broker.scan || !broker.scan.search_url) return null;
    const pii = Store.getPII();
    if (!pii) return broker.scan.search_url;
    // Fill in placeholders from PII
    return broker.scan.search_url
        .replace('{first_name}', encodeURIComponent(pii.first_name || ''))
        .replace('{last_name}', encodeURIComponent(pii.last_name || ''))
        .replace('{city}', encodeURIComponent(pii.city || ''))
        .replace('{state}', encodeURIComponent(pii.state || ''))
        .replace('{full_name}', encodeURIComponent(pii.full_name || ''));
}

function buildNoncompliance(broker, sentEntry) {
    const pii = Store.getPII();
    const fields = Store.getTemplateFields();
    if (!pii || !fields) return null;

    const sentDate = new Date(sentEntry.sentAt);
    const daysElapsed = daysBetween(sentDate, new Date());
    const deadline = broker.optout?.legal_max_days || 45;

    const templateFields = {
        ...fields,
        original_request_date: sentDate.toLocaleDateString('en-US', {
            year: 'numeric', month: 'long', day: 'numeric',
        }),
        days_elapsed: String(daysElapsed),
        legal_deadline_days: String(deadline),
        request_reference_id: `DP-${broker.id}-${sentDate.toISOString().slice(0, 10)}`,
    };

    const filled = Templates.fill('noncompliance_notice', templateFields, broker);
    if (!filled) return null;

    const emailTo = broker.optout?.methods?.find(m => m.type === 'email')?.email_to;
    if (!emailTo) return null;

    return {
        mailto: `mailto:${emailTo}?subject=${encodeURIComponent(filled.subject)}&body=${encodeURIComponent(filled.body)}`,
        subject: filled.subject,
        body: filled.body,
        emailTo,
    };
}

export const Progress = {
    render(container, registryData) {
        const progress = Store.getProgress();
        const entries = Object.entries(progress);
        const sentCount = entries.length;
        const brokers = registryData ? registryData.brokers : [];
        const totalBrokers = brokers.filter(b =>
            b.optout?.methods?.some(m => m.type === 'email')
        ).length;

        const now = Date.now();

        // Categorize entries
        const overdue = [];
        const pending = [];
        const verified = [];

        entries.forEach(([id, p]) => {
            const broker = brokers.find(b => b.id === id);
            if (!broker) return;
            const deadline = broker.optout?.legal_max_days || 45;
            const sentDate = new Date(p.sentAt).getTime();
            const daysAgo = daysBetween(sentDate, now);

            const entry = { id, broker, progress: p, daysAgo, deadline };

            if (p.status === 'verified') {
                verified.push(entry);
            } else if (daysAgo > deadline) {
                overdue.push(entry);
            } else {
                pending.push(entry);
            }
        });

        // Brokers with search URLs for verification
        const verifiable = entries
            .map(([id, p]) => {
                const broker = brokers.find(b => b.id === id);
                if (!broker) return null;
                const searchUrl = getSearchUrl(broker);
                if (!searchUrl) return null;
                return { id, broker, progress: p, searchUrl };
            })
            .filter(Boolean);

        container.innerHTML = `
            <h2 class="mb-2">Monitoring & Progress</h2>

            <div class="progress-header">
                <div class="progress-stat-card">
                    <div class="value">${sentCount}</div>
                    <div class="label">Sent</div>
                </div>
                <div class="progress-stat-card">
                    <div class="value">${verified.length}</div>
                    <div class="label">Verified Removed</div>
                </div>
                <div class="progress-stat-card ${overdue.length > 0 ? 'stat-alert' : ''}">
                    <div class="value">${overdue.length}</div>
                    <div class="label">Overdue</div>
                </div>
                <div class="progress-stat-card">
                    <div class="value">${totalBrokers - sentCount}</div>
                    <div class="label">Remaining</div>
                </div>
            </div>

            ${overdue.length > 0 ? `
            <div class="card mt-2 card-alert">
                <div class="card-header">
                    <div class="card-title">Overdue — Send Noncompliance Notices</div>
                </div>
                <p class="text-sm text-secondary mb-1">
                    These brokers have exceeded their legal response deadline.
                    One click generates a formal noncompliance notice citing the specific
                    violation, deadline, and penalties.
                </p>
                <div id="overdue-list">
                    ${overdue.map(e => {
                        const emailTo = e.broker.optout?.methods?.find(m => m.type === 'email')?.email_to || '';
                        return `
                        <div class="progress-item progress-item-overdue">
                            <div>
                                <span class="progress-item-name">${esc(e.broker.name)}</span>
                                <span class="text-sm text-muted"> &mdash; ${e.daysAgo} days (deadline: ${e.deadline})</span>
                            </div>
                            <div class="progress-item-actions">
                                <button class="btn btn-danger btn-sm btn-noncompliance" data-broker-id="${esc(e.id)}">
                                    Send Noncompliance Notice
                                </button>
                            </div>
                        </div>`;
                    }).join('')}
                </div>
                <div class="mt-1">
                    <button class="btn btn-outline btn-sm" id="btn-send-all-noncompliance">
                        Send All Noncompliance Notices
                    </button>
                </div>
            </div>
            ` : ''}

            ${pending.length > 0 ? `
            <div class="card mt-2">
                <div class="card-header">
                    <div class="card-title">Awaiting Response</div>
                </div>
                <p class="text-sm text-secondary mb-1">
                    Within legal deadline. Check back when they expire.
                </p>
                ${pending
                    .sort((a, b) => a.deadline - a.daysAgo - (b.deadline - b.daysAgo))
                    .map(e => {
                        const remaining = e.deadline - e.daysAgo;
                        const pct = Math.min(100, Math.round((e.daysAgo / e.deadline) * 100));
                        return `
                        <div class="progress-item">
                            <div>
                                <span class="progress-item-name">${esc(e.broker.name)}</span>
                                <span class="text-sm text-muted"> &mdash; ${remaining} days remaining</span>
                            </div>
                            <div class="progress-bar-mini">
                                <div class="progress-bar-fill" style="width:${pct}%"></div>
                            </div>
                        </div>`;
                    }).join('')}
            </div>
            ` : ''}

            ${verifiable.length > 0 ? `
            <div class="card mt-2">
                <div class="card-header">
                    <div class="card-title">Verify Removal</div>
                </div>
                <p class="text-sm text-secondary mb-1">
                    These brokers have public search pages. Check if your data has been removed,
                    then mark as verified.
                </p>
                <div id="verify-list">
                    ${verifiable.map(v => {
                        const isVerified = v.progress.status === 'verified';
                        return `
                        <div class="progress-item ${isVerified ? 'progress-item-verified' : ''}">
                            <div>
                                <span class="progress-item-name">${esc(v.broker.name)}</span>
                                ${isVerified ? '<span class="badge badge-sent">Verified</span>' : ''}
                            </div>
                            <div class="progress-item-actions">
                                <a href="${esc(v.searchUrl)}" class="btn btn-outline btn-sm" target="_blank" rel="noopener">
                                    Check
                                </a>
                                ${!isVerified ? `
                                <button class="btn btn-sm btn-success btn-verify" data-broker-id="${esc(v.id)}">
                                    Mark Removed
                                </button>
                                <button class="btn btn-sm btn-danger btn-still-listed" data-broker-id="${esc(v.id)}">
                                    Still Listed
                                </button>` : ''}
                            </div>
                        </div>`;
                    }).join('')}
                </div>
            </div>
            ` : ''}

            <div class="card mt-2">
                <div class="card-header">
                    <div class="card-title">Free Monitoring Tools</div>
                </div>
                <p class="text-sm text-secondary mb-1">
                    Set up ongoing monitoring so you're alerted when your data appears online.
                </p>
                <div class="monitoring-tools">
                    <div class="monitoring-tool">
                        <strong>Google Alerts</strong>
                        <p class="text-sm text-secondary">Get email alerts when your name appears in new search results.</p>
                        <a href="https://www.google.com/alerts" class="btn btn-outline btn-sm" target="_blank" rel="noopener">
                            Set Up Alert
                        </a>
                        <p class="text-sm text-muted mt-1">
                            Tip: Create alerts for <code>"your full name"</code> in quotes,
                            and also <code>"your email"</code>.
                        </p>
                    </div>
                    <div class="monitoring-tool">
                        <strong>Have I Been Pwned</strong>
                        <p class="text-sm text-secondary">Check if your email has been in any data breaches and subscribe for future notifications.</p>
                        <a href="https://haveibeenpwned.com/" class="btn btn-outline btn-sm" target="_blank" rel="noopener">
                            Check Breaches
                        </a>
                    </div>
                    <div class="monitoring-tool">
                        <strong>Mozilla Monitor</strong>
                        <p class="text-sm text-secondary">Free service from Mozilla that scans data brokers and alerts you when your data is found.</p>
                        <a href="https://monitor.mozilla.org/" class="btn btn-outline btn-sm" target="_blank" rel="noopener">
                            Start Monitoring
                        </a>
                    </div>
                </div>
            </div>

            <div class="card mt-2">
                <div class="card-header">
                    <div class="card-title">Re-Send Schedule</div>
                </div>
                <p class="text-sm text-secondary mb-1">
                    Data brokers often re-list data after deletion. Under the California Delete Act,
                    brokers must process new deletion requests every 45 days. We recommend
                    re-sending quarterly.
                </p>
                <div id="resend-info"></div>
            </div>

            <div class="progress-list mt-2">
                <h3 class="mb-1">All Sent Requests</h3>
                ${entries.length === 0
                    ? '<p class="text-muted">No requests sent yet. Head to the Queue tab to get started.</p>'
                    : entries
                        .sort((a, b) => new Date(b[1].sentAt) - new Date(a[1].sentAt))
                        .map(([id, p]) => {
                            const broker = brokers.find(b => b.id === id);
                            const name = broker ? broker.name : id;
                            const emailTo = broker?.optout?.methods?.find(m => m.type === 'email')?.email_to || '';
                            const dateStr = new Date(p.sentAt).toLocaleDateString('en-US', {
                                year: 'numeric', month: 'short', day: 'numeric',
                            });
                            const statusBadge = p.status === 'verified'
                                ? '<span class="badge badge-sent">Verified</span>'
                                : p.status === 'still_listed'
                                    ? '<span class="badge badge-overdue">Still Listed</span>'
                                    : '';
                            return `<div class="progress-item">
                                <div>
                                    <span class="progress-item-name">${esc(name)}</span>
                                    ${emailTo ? `<span class="text-sm text-muted"> &mdash; ${esc(emailTo)}</span>` : ''}
                                    ${statusBadge}
                                </div>
                                <span class="progress-item-date">${dateStr}</span>
                            </div>`;
                        }).join('')
                }
            </div>

            <div class="mt-3 btn-group">
                <button class="btn btn-outline btn-sm" id="btn-export-txt">Export as Text</button>
                <button class="btn btn-outline btn-sm" id="btn-export-json">Export as JSON</button>
                <label class="btn btn-outline btn-sm" style="cursor:pointer">
                    Import JSON
                    <input type="file" accept=".json" id="btn-import" class="sr-only">
                </label>
                <button class="btn btn-danger btn-sm" id="btn-clear">Clear All Data</button>
            </div>
        `;

        // --- Event listeners ---

        // Noncompliance notices
        container.querySelectorAll('.btn-noncompliance').forEach(btn => {
            btn.addEventListener('click', () => {
                const brokerId = btn.dataset.brokerId;
                const broker = brokers.find(b => b.id === brokerId);
                const sentEntry = progress[brokerId];
                if (!broker || !sentEntry) return;

                const nc = buildNoncompliance(broker, sentEntry);
                if (nc) {
                    window.open(nc.mailto, '_blank');
                    showToast(`Noncompliance notice opened for ${broker.name}`);
                } else {
                    showToast('Could not generate notice — check your info');
                }
            });
        });

        // Send all noncompliance
        const btnAllNC = container.querySelector('#btn-send-all-noncompliance');
        if (btnAllNC) {
            btnAllNC.addEventListener('click', () => {
                if (!confirm(`Open noncompliance notices for ${overdue.length} overdue brokers?`)) return;
                let opened = 0;
                overdue.forEach(e => {
                    const nc = buildNoncompliance(e.broker, e.progress);
                    if (nc) {
                        // Copy to clipboard instead of opening many tabs
                        opened++;
                    }
                });
                // Build combined text for all noncompliance notices
                const allNotices = overdue.map(e => {
                    const nc = buildNoncompliance(e.broker, e.progress);
                    if (!nc) return null;
                    return `TO: ${nc.emailTo}\nSubject: ${nc.subject}\n\n${nc.body}\n\n${'—'.repeat(40)}`;
                }).filter(Boolean).join('\n\n');
                navigator.clipboard.writeText(allNotices)
                    .then(() => showToast(`${overdue.length} noncompliance notices copied to clipboard`));
            });
        }

        // Verify removal
        container.querySelectorAll('.btn-verify').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.brokerId;
                Store.updateProgress(id, { status: 'verified', verifiedAt: new Date().toISOString() });
                showToast('Marked as removed');
                Progress.render(container, registryData);
            });
        });

        // Still listed
        container.querySelectorAll('.btn-still-listed').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.brokerId;
                const broker = brokers.find(b => b.id === id);
                Store.updateProgress(id, { status: 'still_listed', checkedAt: new Date().toISOString() });
                if (broker) {
                    const p = Store.getProgress()[id];
                    const nc = buildNoncompliance(broker, p);
                    if (nc) {
                        window.open(nc.mailto, '_blank');
                        showToast(`Still listed — noncompliance notice opened for ${broker.name}`);
                    }
                }
                Progress.render(container, registryData);
            });
        });

        // Re-send info
        const resendEl = container.querySelector('#resend-info');
        if (resendEl && entries.length > 0) {
            const oldest = entries.reduce((min, [, p]) =>
                new Date(p.sentAt) < min ? new Date(p.sentAt) : min,
                new Date()
            );
            const daysSinceFirst = daysBetween(oldest.getTime(), now);
            const nextResend = 90 - (daysSinceFirst % 90);

            if (daysSinceFirst >= 90) {
                resendEl.innerHTML = `
                    <div class="callout callout-action" style="text-align:left; padding: 1rem;">
                        <p class="text-secondary" style="max-width:none;">
                            <strong>Time to re-send!</strong> It has been ${daysSinceFirst} days since your
                            first batch. Go to the <a href="#queue">Queue</a> to send another round.
                            Brokers frequently re-acquire data after deletion.
                        </p>
                    </div>`;
            } else {
                resendEl.innerHTML = `
                    <p class="text-sm text-muted">
                        Next recommended re-send: <strong>in ${nextResend} days</strong>
                        (${daysSinceFirst} days since first batch).
                    </p>`;
            }
        }

        // Export text
        container.querySelector('#btn-export-txt').addEventListener('click', () => {
            const lines = ['DataPurge — Opt-Out Request Log', `Exported: ${new Date().toLocaleString()}`, ''];
            const sorted = entries.sort((a, b) => new Date(a[1].sentAt) - new Date(b[1].sentAt));
            sorted.forEach(([id, p]) => {
                const broker = brokers.find(b => b.id === id);
                const name = broker ? broker.name : id;
                const domain = broker ? broker.domain : '';
                const email = broker?.optout?.methods?.find(m => m.type === 'email')?.email_to || '';
                const dateStr = new Date(p.sentAt).toLocaleDateString('en-US', {
                    year: 'numeric', month: 'short', day: 'numeric',
                });
                let status = '';
                if (p.status === 'verified') status = ' [VERIFIED REMOVED]';
                else if (p.status === 'still_listed') status = ' [STILL LISTED]';
                lines.push(`- ${dateStr}: Sent opt-out request to ${name} (${domain}) via ${email}${status}`);
            });
            lines.push('', `Total: ${entries.length} requests sent`);
            lines.push(`Verified removed: ${verified.length}`);
            if (overdue.length > 0) {
                lines.push('', 'Overdue (past legal response deadline):');
                overdue.forEach(e => {
                    lines.push(`  - ${e.broker.name}: ${e.daysAgo} days (deadline: ${e.deadline} days)`);
                });
            }
            const text = lines.join('\n');
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `datapurge-log-${new Date().toISOString().slice(0, 10)}.txt`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('Log exported');
        });

        // Export JSON
        container.querySelector('#btn-export-json').addEventListener('click', () => {
            const blob = new Blob([Store.exportProgress()], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `datapurge-progress-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('Progress exported');
        });

        // Import JSON
        container.querySelector('#btn-import').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    Store.importProgress(reader.result);
                    showToast('Progress imported');
                    Progress.render(container, registryData);
                } catch {
                    showToast('Invalid file');
                }
            };
            reader.readAsText(file);
        });

        // Clear all
        container.querySelector('#btn-clear').addEventListener('click', () => {
            if (confirm('This will clear all your progress and personal info. Are you sure?')) {
                Store.clearAll();
                showToast('All data cleared');
                window.location.hash = '#setup';
            }
        });
    },
};
