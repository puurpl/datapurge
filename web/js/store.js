/**
 * DataPurge Store — Multi-profile PII & progress storage
 *
 * All data in localStorage (persists across sessions).
 * Multiple profiles supported — each has its own PII and progress.
 */

const PROFILES_KEY = 'datapurge_profiles';
const ACTIVE_KEY = 'datapurge_active_profile';

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function getAllProfiles() {
    return JSON.parse(localStorage.getItem(PROFILES_KEY) || '[]');
}

function saveAllProfiles(profiles) {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

function getActiveId() {
    return localStorage.getItem(ACTIVE_KEY) || null;
}

function getActiveProfile() {
    const id = getActiveId();
    if (!id) return null;
    return getAllProfiles().find(p => p.id === id) || null;
}

// Migrate from old single-profile format
function migrateIfNeeded() {
    if (getAllProfiles().length > 0) return;

    // Check old sessionStorage PII
    const oldPII = sessionStorage.getItem('datapurge_pii');
    const oldProgress = localStorage.getItem('datapurge_progress');

    if (oldPII || oldProgress) {
        const pii = oldPII ? JSON.parse(oldPII) : null;
        const progress = oldProgress ? JSON.parse(oldProgress) : {};
        const profile = {
            id: generateId(),
            label: pii?.full_name || 'My Profile',
            pii: pii || {},
            progress,
            createdAt: new Date().toISOString(),
        };
        saveAllProfiles([profile]);
        localStorage.setItem(ACTIVE_KEY, profile.id);
        // Clean up old keys
        sessionStorage.removeItem('datapurge_pii');
        localStorage.removeItem('datapurge_progress');
    }
}

migrateIfNeeded();

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
            label: piiData.full_name || 'Profile',
            pii: piiData,
            progress: {},
            createdAt: new Date().toISOString(),
        };
        profiles.push(profile);
        saveAllProfiles(profiles);
        localStorage.setItem(ACTIVE_KEY, profile.id);
        return profile;
    },

    switchProfile(profileId) {
        const profiles = getAllProfiles();
        if (profiles.find(p => p.id === profileId)) {
            localStorage.setItem(ACTIVE_KEY, profileId);
        }
    },

    deleteProfile(profileId) {
        let profiles = getAllProfiles();
        profiles = profiles.filter(p => p.id !== profileId);
        saveAllProfiles(profiles);
        if (getActiveId() === profileId) {
            localStorage.setItem(ACTIVE_KEY, profiles.length > 0 ? profiles[0].id : '');
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
            profile.label = data.full_name || 'Profile';
            saveAllProfiles(profiles);
        } else {
            // No active profile — create one
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
        if (!Array.isArray(imported)) throw new Error('Invalid format');
        const existing = getAllProfiles();
        const existingIds = new Set(existing.map(p => p.id));
        imported.forEach(p => {
            if (!existingIds.has(p.id)) {
                existing.push(p);
            }
        });
        saveAllProfiles(existing);
    },

    clearAll() {
        const id = getActiveId();
        this.deleteProfile(id);
    },
};
