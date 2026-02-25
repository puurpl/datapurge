/**
 * DataPurge Progress — Track sent requests
 */

import { Store } from './store.js';

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

export const Progress = {
    render(container, registryData) {
        const progress = Store.getProgress();
        const entries = Object.entries(progress);
        const sentCount = entries.length;
        const brokers = registryData ? registryData.brokers : [];
        const totalBrokers = brokers.filter(b =>
            b.optout?.methods?.some(m => m.type === 'email')
        ).length;

        // Find overdue
        const now = Date.now();
        const overdue = entries.filter(([id, p]) => {
            const broker = brokers.find(b => b.id === id);
            if (!broker) return false;
            const deadline = broker.optout?.legal_max_days || 45;
            const sentDate = new Date(p.sentAt).getTime();
            return (now - sentDate) > (deadline * 86400000) && p.status === 'sent';
        });

        container.innerHTML = `
            <h2 class="mb-2">Progress</h2>
            <div class="progress-header">
                <div class="progress-stat-card">
                    <div class="value">${sentCount}</div>
                    <div class="label">Sent</div>
                </div>
                <div class="progress-stat-card">
                    <div class="value">${totalBrokers - sentCount}</div>
                    <div class="label">Remaining</div>
                </div>
                <div class="progress-stat-card">
                    <div class="value">${overdue.length}</div>
                    <div class="label">Overdue</div>
                </div>
            </div>

            ${overdue.length > 0 ? `
            <div class="overdue-section">
                <h3>Overdue Responses</h3>
                <p class="text-sm mb-1">These brokers have exceeded their legal response deadline. Consider sending a non-compliance notice.</p>
                ${overdue.map(([id, p]) => {
                    const broker = brokers.find(b => b.id === id);
                    const name = broker ? broker.name : id;
                    const days = Math.floor((now - new Date(p.sentAt).getTime()) / 86400000);
                    return `<div class="progress-item">
                        <div>
                            <span class="progress-item-name">${esc(name)}</span>
                            <span class="text-sm text-muted"> &mdash; ${days} days since sent</span>
                        </div>
                    </div>`;
                }).join('')}
            </div>
            ` : ''}

            <div class="progress-list">
                <h3 class="mb-1">Sent Requests</h3>
                ${entries.length === 0
                    ? '<p class="text-muted">No requests sent yet. Head to the Queue tab to get started.</p>'
                    : entries
                        .sort((a, b) => new Date(b[1].sentAt) - new Date(a[1].sentAt))
                        .map(([id, p]) => {
                            const broker = brokers.find(b => b.id === id);
                            const name = broker ? broker.name : id;
                            const dateStr = new Date(p.sentAt).toLocaleDateString('en-US', {
                                year: 'numeric', month: 'short', day: 'numeric',
                            });
                            return `<div class="progress-item">
                                <span class="progress-item-name">${esc(name)}</span>
                                <span class="progress-item-date">${dateStr}</span>
                            </div>`;
                        }).join('')
                }
            </div>

            <div class="mt-3 btn-group">
                <button class="btn btn-outline btn-sm" id="btn-export">Export Progress</button>
                <label class="btn btn-outline btn-sm" style="cursor:pointer">
                    Import Progress
                    <input type="file" accept=".json" id="btn-import" class="sr-only">
                </label>
                <button class="btn btn-danger btn-sm" id="btn-clear">Clear All Data</button>
            </div>
        `;

        container.querySelector('#btn-export').addEventListener('click', () => {
            const blob = new Blob([Store.exportProgress()], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `datapurge-progress-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('Progress exported');
        });

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

        container.querySelector('#btn-clear').addEventListener('click', () => {
            if (confirm('This will clear all your progress and personal info. Are you sure?')) {
                Store.clearAll();
                showToast('All data cleared');
                window.location.hash = '#setup';
            }
        });
    },
};
