/**
 * DataPurge Capacitor Bridge — Android-specific features
 *
 * All exports are safe to import on the web. Methods that use native APIs
 * check isCapacitor() first and are no-ops in a browser context.
 * Capacitor plugins are accessed via window.Capacitor.Plugins (no bundler needed).
 */

// --- Environment detection ---

export function isCapacitor() {
    return typeof window !== 'undefined'
        && window.Capacitor !== undefined
        && window.Capacitor.isNativePlatform();
}

// --- Registry update from GitHub ---

const REGISTRY_CACHE_KEY = 'datapurge_registry_cache';
const TEMPLATES_CACHE_KEY = 'datapurge_templates_cache';
const LAST_UPDATE_KEY = 'datapurge_last_registry_update';
const STALE_DAYS = 7;

const REGISTRY_URL = 'https://raw.githubusercontent.com/puurpl/opt-out/main/web/data/registry.json';
const TEMPLATES_URL = 'https://raw.githubusercontent.com/puurpl/opt-out/main/web/data/templates.json';

export const RegistryUpdater = {
    isStale() {
        const last = localStorage.getItem(LAST_UPDATE_KEY);
        if (!last) return true;
        const daysSince = (Date.now() - new Date(last).getTime()) / 86400000;
        return daysSince > STALE_DAYS;
    },

    getCachedRegistry() {
        try {
            return JSON.parse(localStorage.getItem(REGISTRY_CACHE_KEY));
        } catch { return null; }
    },

    getCachedTemplates() {
        try {
            return JSON.parse(localStorage.getItem(TEMPLATES_CACHE_KEY));
        } catch { return null; }
    },

    async update() {
        const [regResp, tmplResp] = await Promise.all([
            fetch(REGISTRY_URL),
            fetch(TEMPLATES_URL),
        ]);
        if (!regResp.ok || !tmplResp.ok) {
            throw new Error('Failed to fetch registry updates');
        }
        const registry = await regResp.json();
        const templates = await tmplResp.json();

        localStorage.setItem(REGISTRY_CACHE_KEY, JSON.stringify(registry));
        localStorage.setItem(TEMPLATES_CACHE_KEY, JSON.stringify(templates));
        localStorage.setItem(LAST_UPDATE_KEY, new Date().toISOString());

        return { registry, templates };
    },
};

// --- Local notifications ---

function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

export const Notifier = {
    async requestPermission() {
        if (!isCapacitor()) return false;
        const LN = window.Capacitor?.Plugins?.LocalNotifications;
        if (!LN) return false;
        const result = await LN.requestPermissions();
        return result.display === 'granted';
    },

    async scheduleReminder(brokerId, brokerName, deadlineDays) {
        if (!isCapacitor()) return;
        const LN = window.Capacitor?.Plugins?.LocalNotifications;
        if (!LN) return;

        const notifTime = new Date();
        notifTime.setDate(notifTime.getDate() + deadlineDays);

        await LN.schedule({
            notifications: [{
                id: hashCode(brokerId),
                title: 'DataPurge — Check Broker Response',
                body: `${brokerName} should have responded by now (${deadlineDays}-day deadline). Check your progress.`,
                schedule: { at: notifTime },
                extra: { brokerId },
            }],
        });
    },

    async schedulePendingReminder() {
        if (!isCapacitor()) return;
        const LN = window.Capacitor?.Plugins?.LocalNotifications;
        if (!LN) return;

        await LN.schedule({
            notifications: [{
                id: 99999,
                title: 'DataPurge — Pending Opt-Outs',
                body: 'You have unsent opt-out requests. Open DataPurge to continue.',
                schedule: { at: new Date(Date.now() + 3 * 86400000) },
            }],
        });
    },
};

// --- UI adjustments for native shell ---

export function applyCapacitorUI() {
    if (!isCapacitor()) return;

    const style = document.createElement('style');
    style.textContent = `
        .drip-signup-card, .drip-confirmation { display: none !important; }
        .footer { display: none !important; }
    `;
    document.head.appendChild(style);

    document.body.style.paddingTop = 'env(safe-area-inset-top)';
}

// --- Stale data check on launch ---

export async function checkForUpdates() {
    if (!isCapacitor()) return;
    if (!RegistryUpdater.isStale()) return;

    const main = document.querySelector('main') || document.body;
    const banner = document.createElement('div');
    banner.className = 'card';
    banner.style.cssText = 'margin: 1rem 1.5rem; padding: 1rem; text-align: center;';
    const lastUpdate = localStorage.getItem(LAST_UPDATE_KEY);
    banner.innerHTML = `
        <p style="margin-bottom: 0.5rem;"><strong>Broker data may be outdated.</strong></p>
        <p class="text-sm text-secondary" style="margin-bottom: 0.75rem;">Last updated: ${lastUpdate ? new Date(lastUpdate).toLocaleDateString() : 'never'}</p>
        <button class="btn btn-primary btn-sm" id="btn-cap-update">Update Now</button>
        <button class="btn btn-outline btn-sm" id="btn-cap-skip" style="margin-left: 0.5rem;">Skip</button>
    `;

    main.prepend(banner);

    banner.querySelector('#btn-cap-update').addEventListener('click', async () => {
        banner.innerHTML = '<p class="text-sm">Updating broker data...</p>';
        try {
            await RegistryUpdater.update();
            banner.innerHTML = '<p class="text-sm" style="color: var(--color-success);">Updated! Reloading...</p>';
            setTimeout(() => location.reload(), 500);
        } catch {
            banner.innerHTML = '<p class="text-sm" style="color: var(--color-danger);">Update failed. Using bundled data.</p>';
            setTimeout(() => banner.remove(), 3000);
        }
    });

    banner.querySelector('#btn-cap-skip').addEventListener('click', () => banner.remove());
}
