// PWA lifecycle: service worker registration, install prompt, offline
// indicator, update notification. All DOM is built with createElement +
// addEventListener - the CSP (script-src 'self') forbids inline handlers.

const DISMISS_KEY = 'datapurge_install_dismissed';

let deferredPrompt = null;

function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches
        || navigator.standalone === true;
}

function isIOS() {
    // iPadOS reports MacIntel; distinguish via touch support
    return /iphone|ipad|ipod/i.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function dismissInstall() {
    try { localStorage.setItem(DISMISS_KEY, new Date().toISOString()); } catch { /* private mode */ }
    removeInstallBanner();
}

function installDismissed() {
    try { return !!localStorage.getItem(DISMISS_KEY); } catch { return false; }
}

function removeInstallBanner() {
    document.getElementById('install-banner')?.remove();
}

function button(label, className, onClick) {
    const btn = document.createElement('button');
    btn.className = className;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
}

function showInstallBanner(mode) {
    if (document.getElementById('install-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'install-banner';
    banner.className = 'install-banner';

    const text = document.createElement('div');
    text.className = 'install-banner-text';
    const title = document.createElement('strong');
    title.textContent = 'Install DataPurge';
    const desc = document.createElement('p');
    desc.textContent = mode === 'ios'
        ? 'Tap the Share button, then "Add to Home Screen" to use DataPurge as an app - works offline.'
        : 'Add DataPurge to your device for quick access - works offline, your data stays local.';
    text.append(title, desc);

    const actions = document.createElement('div');
    actions.className = 'install-banner-actions';
    if (mode === 'prompt') {
        actions.appendChild(button('Install', 'btn btn-primary btn-sm', async () => {
            const prompt = deferredPrompt;
            deferredPrompt = null;
            removeInstallBanner();
            if (prompt) {
                prompt.prompt();
                try { await prompt.userChoice; } catch { /* user closed native prompt */ }
            }
        }));
    }
    actions.appendChild(button('Not now', 'btn btn-ghost btn-sm', dismissInstall));

    banner.append(text, actions);
    document.body.appendChild(banner);
}

function initInstallPrompt() {
    if (installDismissed() || isStandalone()) return;

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        showInstallBanner('prompt');
    });

    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        removeInstallBanner();
    });

    // Safari never fires beforeinstallprompt; show instructions instead
    if (isIOS()) {
        showInstallBanner('ios');
    }
}

function initOfflineIndicator() {
    const pill = document.createElement('div');
    pill.id = 'offline-pill';
    pill.className = 'offline-pill';
    pill.setAttribute('role', 'status');
    pill.textContent = 'Offline - your data is saved locally';
    document.body.appendChild(pill);

    const update = () => pill.classList.toggle('show', !navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
}

function showUpdateToast() {
    if (document.getElementById('update-toast')) return;

    const toast = document.createElement('div');
    toast.id = 'update-toast';
    toast.className = 'update-toast';

    const msg = document.createElement('span');
    msg.textContent = 'DataPurge has been updated.';

    toast.append(
        msg,
        button('Reload', 'btn btn-primary btn-sm', () => location.reload()),
        button('×', 'btn btn-ghost btn-sm', () => toast.remove()),
    );
    document.body.appendChild(toast);
}

function registerSW() {
    if (!('serviceWorker' in navigator)) return;

    // On first install clients.claim() fires controllerchange too -
    // only an existing controller means an actual update happened.
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hadController) showUpdateToast();
    });
}

export const PWA = {
    init() {
        registerSW();
        initInstallPrompt();
        initOfflineIndicator();
    },
};
