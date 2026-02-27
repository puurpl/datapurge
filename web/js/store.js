/**
 * DataPurge Store — Multi-profile PII & progress storage
 *
 * All data in localStorage (persists across sessions).
 * Multiple profiles supported — each has its own PII and progress.
 */

const PROFILES_KEY = 'datapurge_profiles';
const ACTIVE_KEY = 'datapurge_active_profile';

function generateId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

function safeGetItem(key) {
    try { return localStorage.getItem(key); }
    catch { return null; }
}

function safeSetItem(key, value) {
    try { localStorage.setItem(key, value); }
    catch (e) {
        console.warn('localStorage write failed:', e.message);
        showStorageWarning();
    }
}

function safeRemoveItem(key) {
    try { localStorage.removeItem(key); }
    catch { /* ignore */ }
}

let _storageWarningShown = false;
function showStorageWarning() {
    if (_storageWarningShown) return;
    _storageWarningShown = true;
    const toast = document.getElementById('toast');
    if (toast) {
        toast.textContent = 'Storage is full — some data may not be saved.';
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 4000);
    }
}

function getAllProfiles() {
    try {
        return JSON.parse(safeGetItem(PROFILES_KEY) || '[]');
    } catch {
        console.warn('Corrupt profile data — resetting.');
        return [];
    }
}

function saveAllProfiles(profiles) {
    safeSetItem(PROFILES_KEY, JSON.stringify(profiles));
}

function getActiveId() {
    return safeGetItem(ACTIVE_KEY) || null;
}

function getActiveProfile() {
    const id = getActiveId();
    if (!id) return null;
    return getAllProfiles().find(p => p.id === id) || null;
}

// Migrate from old single-profile format
function migrateIfNeeded() {
    try {
        if (getAllProfiles().length > 0) return;

        let oldPII = null;
        let oldProgress = {};
        try { oldPII = JSON.parse(sessionStorage.getItem('datapurge_pii')); } catch { /* ignore */ }
        try { oldProgress = JSON.parse(safeGetItem('datapurge_progress')) || {}; } catch { /* ignore */ }

        if (oldPII || Object.keys(oldProgress).length > 0) {
            const profile = {
                id: generateId(),
                label: oldPII?.full_name || 'My Profile',
                pii: oldPII || {},
                progress: oldProgress,
                createdAt: new Date().toISOString(),
            };
            saveAllProfiles([profile]);
            safeSetItem(ACTIVE_KEY, profile.id);
            try { sessionStorage.removeItem('datapurge_pii'); } catch { /* ignore */ }
            safeRemoveItem('datapurge_progress');
        }
    } catch (e) {
        console.warn('Migration failed:', e.message);
    }
}

migrateIfNeeded();

// Cross-tab sync — refresh when another tab modifies localStorage
if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
        if (e.key === PROFILES_KEY || e.key === ACTIVE_KEY) {
            // Dispatch custom event so views can re-render
            window.dispatchEvent(new CustomEvent('datapurge-storage-sync'));
        }
    });
}

function uniqueLabel(label, profiles) {
    const base = label || 'Profile';
    const existing = profiles.map(p => p.label);
    if (!existing.includes(base)) return base;
    let n = 2;
    while (existing.includes(`${base} ${n}`)) n++;
    return `${base} ${n}`;
}

export const Store = {
    // --- Profiles ---

    getProfiles() {
        return getAllProfiles();
    },

    getActiveProfileId() {
        return getActiveId();
    },

    getActiveProfile() {
        return getActiveProfile();
    },

    createProfile(piiData) {
        const profiles = getAllProfiles();
        const parts = (piiData.full_name || '').trim().split(/\s+/);
        piiData.first_name = parts[0] || '';
        piiData.last_name = parts.slice(1).join(' ') || '';
        if (piiData.street && piiData.city && piiData.state && !piiData.address) {
            piiData.address = `${piiData.street}, ${piiData.city}, ${piiData.state} ${piiData.zip || ''}`.trim();
        }
        const profile = {
            id: generateId(),
            label: uniqueLabel(piiData.full_name, profiles),
            pii: piiData,
            progress: {},
            createdAt: new Date().toISOString(),
        };
        profiles.push(profile);
        saveAllProfiles(profiles);
        safeSetItem(ACTIVE_KEY, profile.id);
        return profile;
    },

    switchProfile(profileId) {
        const profiles = getAllProfiles();
        if (profiles.find(p => p.id === profileId)) {
            safeSetItem(ACTIVE_KEY, profileId);
        }
    },

    deleteProfile(profileId) {
        let profiles = getAllProfiles();
        profiles = profiles.filter(p => p.id !== profileId);
        saveAllProfiles(profiles);
        if (getActiveId() === profileId) {
            if (profiles.length > 0) {
                safeSetItem(ACTIVE_KEY, profiles[0].id);
            } else {
                safeRemoveItem(ACTIVE_KEY);
            }
        }
    },

    // --- PII (on active profile) ---

    setPII(data) {
        const parts = (data.full_name || '').trim().split(/\s+/);
        data.first_name = parts[0] || '';
        data.last_name = parts.slice(1).join(' ') || '';
        if (data.street && data.city && data.state && !data.address) {
            data.address = `${data.street}, ${data.city}, ${data.state} ${data.zip || ''}`.trim();
        }

        const profiles = getAllProfiles();
        const id = getActiveId();
        const profile = profiles.find(p => p.id === id);
        if (profile) {
            profile.pii = data;
            profile.label = data.full_name || profile.label;
            saveAllProfiles(profiles);
        } else {
            this.createProfile(data);
        }
    },

    getPII() {
        const profile = getActiveProfile();
        return profile ? profile.pii : null;
    },

    hasPII() {
        const pii = this.getPII();
        return pii && pii.full_name && pii.email;
    },

    clearPII() {
        const profiles = getAllProfiles();
        const id = getActiveId();
        const profile = profiles.find(p => p.id === id);
        if (profile) {
            profile.pii = {};
            saveAllProfiles(profiles);
        }
    },

    getTemplateFields() {
        const pii = this.getPII();
        if (!pii) return null;

        const aliases = (pii.email_aliases || []).filter(e => e);
        let additional_emails = '';
        if (aliases.length > 0) {
            additional_emails = 'Additional email addresses: ' + aliases.join(', ');
        }

        return {
            full_name: pii.full_name || '',
            first_name: pii.first_name || '',
            last_name: pii.last_name || '',
            email: pii.email || '',
            additional_emails,
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

    // --- Progress (on active profile) ---

    getProgress() {
        const profile = getActiveProfile();
        return profile ? (profile.progress || {}) : {};
    },

    markSent(brokerId) {
        const profiles = getAllProfiles();
        const id = getActiveId();
        const profile = profiles.find(p => p.id === id);
        if (!profile) return;
        if (!profile.progress) profile.progress = {};
        profile.progress[brokerId] = {
            sentAt: new Date().toISOString(),
            status: 'sent',
        };
        saveAllProfiles(profiles);
    },

    updateProgress(brokerId, updates) {
        const profiles = getAllProfiles();
        const id = getActiveId();
        const profile = profiles.find(p => p.id === id);
        if (!profile || !profile.progress || !profile.progress[brokerId]) return;
        Object.assign(profile.progress[brokerId], updates);
        saveAllProfiles(profiles);
    },

    isSent(brokerId) {
        return !!this.getProgress()[brokerId];
    },

    clearProgress() {
        const profiles = getAllProfiles();
        const id = getActiveId();
        const profile = profiles.find(p => p.id === id);
        if (profile) {
            profile.progress = {};
            saveAllProfiles(profiles);
        }
    },

    exportProgress() {
        return JSON.stringify(this.getProgress(), null, 2);
    },

    exportAll() {
        return JSON.stringify(getAllProfiles(), null, 2);
    },

    importProgress(jsonString) {
        const data = JSON.parse(jsonString);
        if (typeof data !== 'object' || data === null || Array.isArray(data)) {
            throw new Error('Invalid progress format — expected an object');
        }
        const profiles = getAllProfiles();
        const id = getActiveId();
        const profile = profiles.find(p => p.id === id);
        if (profile) {
            profile.progress = data;
            saveAllProfiles(profiles);
        }
    },

    importAll(jsonString) {
        const imported = JSON.parse(jsonString);
        if (!Array.isArray(imported)) throw new Error('Invalid format — expected an array');
        const existing = getAllProfiles();
        const existingIds = new Set(existing.map(p => p.id));
        imported.forEach(p => {
            if (p && typeof p === 'object' && p.id && !existingIds.has(p.id)) {
                // Sanitize: ensure expected shape
                existing.push({
                    id: String(p.id),
                    label: String(p.label || 'Imported Profile'),
                    pii: (typeof p.pii === 'object' && p.pii) ? p.pii : {},
                    progress: (typeof p.progress === 'object' && p.progress) ? p.progress : {},
                    createdAt: p.createdAt || new Date().toISOString(),
                });
            }
        });
        saveAllProfiles(existing);
    },

    clearAll() {
        const id = getActiveId();
        this.deleteProfile(id);
    },
};
