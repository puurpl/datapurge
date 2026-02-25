/**
 * DataPurge Store — PII & progress storage
 *
 * PII → sessionStorage (dies on tab close)
 * Progress → localStorage (persists across sessions)
 */

const PII_KEY = 'datapurge_pii';
const PROGRESS_KEY = 'datapurge_progress';

export const Store = {
    // --- PII (sessionStorage) ---

    setPII(data) {
        const parts = data.full_name.trim().split(/\s+/);
        data.first_name = parts[0] || '';
        data.last_name = parts.slice(1).join(' ') || '';
        if (data.street && data.city && data.state && !data.address) {
            data.address = `${data.street}, ${data.city}, ${data.state} ${data.zip || ''}`.trim();
        }
        sessionStorage.setItem(PII_KEY, JSON.stringify(data));
    },

    getPII() {
        const raw = sessionStorage.getItem(PII_KEY);
        return raw ? JSON.parse(raw) : null;
    },

    hasPII() {
        return sessionStorage.getItem(PII_KEY) !== null;
    },

    clearPII() {
        sessionStorage.removeItem(PII_KEY);
    },

    getTemplateFields() {
        const pii = this.getPII();
        if (!pii) return null;
        return {
            full_name: pii.full_name || '',
            first_name: pii.first_name || '',
            last_name: pii.last_name || '',
            email: pii.email || '',
            phone: pii.phone || '',
            address: pii.address || '',
            street: pii.street || '',
            city: pii.city || '',
            state: pii.state || '',
            zip: pii.zip || '',
            dob: pii.dob || '',
            date: new Date().toLocaleDateString('en-US', {
                year: 'numeric', month: 'long', day: 'numeric',
            }),
        };
    },

    // --- Progress (localStorage) ---

    getProgress() {
        return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
    },

    markSent(brokerId) {
        const progress = this.getProgress();
        progress[brokerId] = {
            sentAt: new Date().toISOString(),
            status: 'sent',
        };
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
    },

    isSent(brokerId) {
        return !!this.getProgress()[brokerId];
    },

    clearProgress() {
        localStorage.removeItem(PROGRESS_KEY);
    },

    exportProgress() {
        return JSON.stringify(this.getProgress(), null, 2);
    },

    importProgress(jsonString) {
        const data = JSON.parse(jsonString);
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(data));
    },

    clearAll() {
        this.clearPII();
        this.clearProgress();
    },
};
