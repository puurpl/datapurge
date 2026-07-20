/**
 * DataPurge Reply Mailbox - inbound-only email alias integration (app side)
 *
 * A paid, private inbox alias for contacting data collectors. The alias is the
 * contact address brokers keep on file and type into their request forms, and it
 * is where their replies, verification loops, and marketing-list abuse land. The
 * relay only ever emails YOU, never brokers. Reply bodies are sealed to a key that
 * only your browser holds, so we (and our infrastructure) hold ciphertext only.
 *
 * Everything ships DARK behind RELAY_LIVE = false. When false, no network call
 * ever fires and the profile card / queue entry point show a "coming soon" preview.
 * This mirrors the DRIP_LIVE pattern in queue.js.
 */

import { Store } from './store.js';

// --- Feature flag ---
// Flip to true only once the relay worker is deployed and the domain is live.
const RELAY_LIVE = false;

// --- Constants ---
// Set at launch: the relay API host lives at api.<relay-domain>. This placeholder
// is swapped for the real host (and mirrored in web/_headers connect-src) then.
const RELAY_API_URL = 'https://api.REPLACE-RELAY-DOMAIN.example';

// localStorage record:
// { alias, secret, privateKeyJwk, publicKeyRaw, claimedAt, lastSync, keyBackedUp }
const RELAY_KEY = 'datapurge_relay';

// HKDF info string - must match the worker's sealing routine exactly.
const HKDF_INFO = 'datapurge-relay-v1';

const CLASSIFICATION_LABELS = {
    ack: 'broker replied',
    verification_required: 'verification needed',
    completed: 'completed - confirm removal',
    rejected_use_form: 'use their form',
    bounce_ndr: 'delivery failed',
    unrelated: 'reply received',
};

// --- Small shared helpers ---

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

function classificationLabel(type) {
    return CLASSIFICATION_LABELS[type] || 'reply received';
}

// --- State ---

function getRelayState() {
    try { return JSON.parse(localStorage.getItem(RELAY_KEY)); }
    catch { return null; }
}

function saveRelayState(state) {
    try { localStorage.setItem(RELAY_KEY, JSON.stringify(state)); }
    catch { /* ignore quota / privacy-mode failures */ }
}

function clearRelayState() {
    try { localStorage.removeItem(RELAY_KEY); }
    catch { /* ignore */ }
}

// True only when the flag is on AND the API host has actually been configured.
// Every network path checks this, so a placeholder host can never be hit.
function isConfigured() {
    return RELAY_LIVE && RELAY_API_URL.indexOf('REPLACE-RELAY-DOMAIN') === -1;
}

function isActive() {
    const s = getRelayState();
    return !!(s && s.alias && s.secret);
}

function getActiveAlias() {
    const s = getRelayState();
    return (s && s.alias) ? s.alias : null;
}

// Authorization: Bearer {aliasLocalPart}.{secret} where the alias local part
// looks like u-abc23xyz (everything before the @).
function authHeader() {
    const s = getRelayState();
    if (!s || !s.alias || !s.secret) return null;
    const localPart = s.alias.split('@')[0];
    return `Bearer ${localPart}.${s.secret}`;
}

// --- Crypto (native WebCrypto ECIES, no libraries) ---

function base64urlFromBytes(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesFromBase64(b64) {
    // Accept both standard and url-safe base64.
    const norm = String(b64).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(norm);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

// ECDH P-256 keypair. Private key is stored as a JWK in localStorage; the public
// key is uploaded at claim time as base64url(raw export) = 65 bytes (0x04 || X || Y).
async function generateKeypair() {
    const kp = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveKey', 'deriveBits']
    );
    const privateKeyJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const rawPub = await crypto.subtle.exportKey('raw', kp.publicKey);
    return {
        privateKeyJwk,
        publicKeyRaw: base64urlFromBytes(new Uint8Array(rawPub)),
    };
}

// Decrypt a sealed blob produced by the worker:
//   base64 -> bytes; ephemeralPubRaw = bytes[0..65); iv = bytes[65..77); ct = rest
//   ECDH(ephemeralPub, userPrivate) -> 256-bit shared secret
//   HKDF-SHA256(ikm=shared, salt=empty, info="datapurge-relay-v1") -> AES-256-GCM key
//   AES-256-GCM decrypt(ct, iv) -> JSON { text, html, from, subject, received_at }
async function decryptSealed(b64, privateKeyJwk) {
    const bytes = bytesFromBase64(b64);
    const ephemeralPubRaw = bytes.slice(0, 65);
    const iv = bytes.slice(65, 77);
    const ct = bytes.slice(77);

    const privateKey = await crypto.subtle.importKey(
        'jwk', privateKeyJwk,
        { name: 'ECDH', namedCurve: 'P-256' },
        false, ['deriveBits']
    );
    const ephemeralPub = await crypto.subtle.importKey(
        'raw', ephemeralPubRaw,
        { name: 'ECDH', namedCurve: 'P-256' },
        false, []
    );
    const sharedBits = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: ephemeralPub },
        privateKey, 256
    );
    const hkdfKey = await crypto.subtle.importKey(
        'raw', sharedBits, 'HKDF', false, ['deriveKey']
    );
    const aesKey = await crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new Uint8Array(0),
            info: new TextEncoder().encode(HKDF_INFO),
        },
        hkdfKey,
        { name: 'AES-GCM', length: 256 },
        false, ['decrypt']
    );
    const plainBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        aesKey, ct
    );
    return JSON.parse(new TextDecoder().decode(plainBuf));
}

// --- Fragment capture ---

// After confirmation the worker 302s to
//   ${SITE}/app.html#relay=u-{slug}@{domain}:{secret}
// Parse it, split alias vs secret on the LAST colon (the alias itself has none,
// but be defensive), merge into any keypair generated at claim time, then strip
// the fragment so the secret never lingers in the URL, history or a bookmark.
function captureFragmentToken() {
    const hash = location.hash || '';

    // Transient outcome fragments from the worker's redirects: surface them
    // once via the profile card, then strip so they never linger in the URL.
    if (hash.indexOf('#relay_checkout=') === 0 || hash.indexOf('#relay_error=') === 0) {
        const isError = hash.indexOf('#relay_error=') === 0;
        const value = decodeURIComponent(hash.slice(hash.indexOf('=') + 1));
        let notice;
        if (isError) {
            notice = 'That confirmation link is invalid or has expired - request a new one from the Reply Mailbox card.';
        } else if (value === 'success') {
            notice = 'Payment received - check your inbox for the confirmation link to activate your alias.';
        } else {
            notice = 'Checkout was cancelled - you can restart it from the Reply Mailbox card any time.';
        }
        saveRelayState({ ...(getRelayState() || {}), notice });
        try {
            history.replaceState(null, '', location.pathname + location.search);
        } catch {
            location.hash = '';
        }
        return false;
    }

    if (hash.indexOf('#relay=') !== 0) return false;

    const value = decodeURIComponent(hash.slice('#relay='.length));
    const lastColon = value.lastIndexOf(':');
    if (lastColon < 0) return false;

    const alias = value.slice(0, lastColon).trim();
    const secret = value.slice(lastColon + 1).trim();
    if (!alias || !secret) return false;

    const existing = getRelayState() || {};
    saveRelayState({
        ...existing,
        alias,
        secret,
        claimedAt: existing.claimedAt || new Date().toISOString(),
    });

    try {
        history.replaceState(null, '', location.pathname + location.search);
    } catch {
        location.hash = '';
    }
    return true;
}

// --- API calls (all gated on isConfigured()) ---

async function claim(email) {
    if (!isConfigured()) throw new Error('The Reply Mailbox is not available yet.');

    // Generate the keypair first and persist the private key immediately, so a
    // mid-flow redirect to checkout can never lose it. Only the public key leaves.
    const { privateKeyJwk, publicKeyRaw } = await generateKeypair();
    saveRelayState({ ...(getRelayState() || {}), privateKeyJwk, publicKeyRaw });

    const resp = await fetch(`${RELAY_API_URL}/api/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, pubkey: publicKeyRaw }),
    });

    if (resp.status === 409) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || 'That address is already claimed.');
    }
    if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || `Claim failed (${resp.status}).`);
    }
    return resp.json().catch(() => ({})); // { checkout_url } or { status: 'pending_confirm' }
}

// Fire-and-forget background sync. Silent no-op when dark, unconfigured, or not
// yet active. Pulls replies since the last sync and folds them into progress.
async function syncReplies() {
    if (!isConfigured() || !isActive()) return;
    const auth = authHeader();
    if (!auth) return;

    const state = getRelayState();
    const since = state && state.lastSync ? state.lastSync : '';
    try {
        const url = `${RELAY_API_URL}/api/replies${since ? `?since=${encodeURIComponent(since)}` : ''}`;
        const resp = await fetch(url, { headers: { Authorization: auth } });
        if (!resp.ok) return;
        const data = await resp.json().catch(() => null);
        if (!data || !Array.isArray(data.replies)) return;
        Store.mergeRelayReplies(data.replies);
        // Cursor on the server's own timestamps: stamping the client clock here
        // would skip replies whenever it runs ahead of the server.
        let cursor = state && state.lastSync ? state.lastSync : '';
        data.replies.forEach(r => {
            if (r && r.received_at && r.received_at > cursor) cursor = r.received_at;
        });
        if (cursor) saveRelayState({ ...getRelayState(), lastSync: cursor });
    } catch {
        /* silent - best-effort background sync */
    }
}

async function fetchEvidence(id) {
    if (!isConfigured() || !isActive()) return null;
    const auth = authHeader();
    if (!auth) return null;
    const resp = await fetch(`${RELAY_API_URL}/api/evidence/${encodeURIComponent(id)}`, {
        headers: { Authorization: auth },
    });
    if (!resp.ok) throw new Error(`Could not load evidence (${resp.status}).`);
    return resp.json().catch(() => null); // { id, sealed, classification, sender_domain, received_at }
}

async function decryptEvidence(evidence) {
    const state = getRelayState();
    if (!state || !state.privateKeyJwk) {
        throw new Error('No decryption key on this device. Restore your key backup to read stored messages.');
    }
    if (!evidence || !evidence.sealed) {
        throw new Error('This record has no stored message body.');
    }
    return decryptSealed(evidence.sealed, state.privateKeyJwk);
}

async function getAlias() {
    if (!isConfigured() || !isActive()) return null;
    const auth = authHeader();
    if (!auth) return null;
    const resp = await fetch(`${RELAY_API_URL}/api/alias`, { headers: { Authorization: auth } });
    if (!resp.ok) return null;
    return resp.json().catch(() => null);
}

async function updateSettings(settings) {
    if (!isConfigured() || !isActive()) throw new Error('The Reply Mailbox is not active.');
    const auth = authHeader();
    const resp = await fetch(`${RELAY_API_URL}/api/alias/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify(settings),
    });
    if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || `Update failed (${resp.status}).`);
    }
    return resp.json().catch(() => ({}));
}

async function deleteAlias() {
    if (!isConfigured() || !isActive()) throw new Error('The Reply Mailbox is not active.');
    const auth = authHeader();
    const resp = await fetch(`${RELAY_API_URL}/api/alias/delete`, {
        method: 'POST',
        headers: { Authorization: auth },
    });
    if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || `Delete failed (${resp.status}).`);
    }
    clearRelayState();
    return true;
}

// --- Key backup (one-time, client-side .txt) ---

function downloadKeyBackup() {
    const state = getRelayState();
    if (!state || !state.privateKeyJwk) return false;
    const lines = [
        'DataPurge Reply Mailbox - key backup',
        '',
        'Keep this file private. It is the only way to read your stored broker',
        'replies if you lose this browser or move to another device. Anyone with',
        'this file can read the message bodies stored for your alias.',
        '',
        `Alias: ${state.alias || '(pending confirmation)'}`,
        `Saved: ${new Date().toISOString()}`,
        '',
        'Private key (JWK):',
        JSON.stringify(state.privateKeyJwk),
        '',
        'Public key (base64url, raw):',
        state.publicKeyRaw || '',
        '',
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'datapurge-reply-mailbox-key.txt';
    a.click();
    URL.revokeObjectURL(url);

    saveRelayState({ ...getRelayState(), keyBackedUp: true });
    return true;
}

// --- Rendering: queue entry point ---

// Replaces the manual-alias nudge inside the queue "How this works" callout.
// Dark: a compact "coming soon" preview. Live+active: shows the alias to paste.
function renderQueueEntryPoint(container) {
    if (!container) return;

    if (!RELAY_LIVE) {
        container.innerHTML = `
            <div class="drip-badge mb-1" style="text-transform:uppercase;">Coming Soon</div>
            <p class="text-sm text-secondary" style="max-width:none;">
                <strong>Reply Mailbox.</strong> A private inbox alias you can give brokers
                instead of your own address, so their replies, verification requests and any
                marketing-list abuse land in one place you control - with pause and block
                controls and a private evidence trail. Until it launches, to track who
                mishandles your request you can add a dedicated alias under
                <em>Additional Email Addresses</em> in your profile.
            </p>
        `;
        return;
    }

    if (isActive()) {
        const alias = getActiveAlias();
        container.innerHTML = `
            <p class="text-sm text-secondary" style="max-width:none;">
                <strong>Your Reply Mailbox is active.</strong> Brokers write back to
                <code>${esc(alias)}</code> instead of your personal inbox. Paste it as your
                contact email in any web form; replies and verification requests then appear
                in your <a href="app.html#progress">Progress</a> tab.
            </p>
        `;
        return;
    }

    container.innerHTML = `
        <p class="text-sm text-secondary" style="max-width:none;">
            <strong>Keep broker replies out of your personal inbox.</strong> The Reply Mailbox
            gives you a private alias to hand brokers, with pause and block controls and an
            evidence trail. Set it up on your <a href="app.html#setup">profile</a>.
        </p>
    `;
}

// --- Rendering: profile card ---

function buildPreviewCard() {
    const card = document.createElement('div');
    card.className = 'card drip-signup-card mb-2';
    card.innerHTML = `
        <div class="card-header">
            <div>
                <div class="drip-badge mb-1">Coming Soon</div>
                <div class="card-title">Reply Mailbox</div>
            </div>
        </div>
        <p class="text-secondary mb-2" style="max-width:none;">
            A private inbox alias for contacting data collectors. Your personal email address
            stays out of data-broker hands: the alias is the contact address brokers keep on
            file and type into their request forms, and it is where their replies, verification
            loops and marketing-list abuse land. You get pause and block controls and a private
            evidence trail of every reply, readable only by you.
        </p>
        <p class="text-secondary text-sm mb-2" style="max-width:none;">
            It will be a paid service, and subscribing is two things at once: a working private
            mail tool and a contribution to the project's fight against blanket surveillance.
            Both readings are true - it keeps DataPurge free for everyone, and it covers running
            costs and time rather than turning a profit. The relay only ever emails you, never
            brokers. See the <a href="privacy.html">privacy policy</a> for exactly what is stored.
        </p>
        <button class="btn btn-primary" disabled style="width:100%; opacity:0.6; cursor:not-allowed;">
            Coming Soon
        </button>
    `;
    return card;
}

function buildClaimCard(container) {
    const pii = Store.getPII();
    const card = document.createElement('div');
    card.className = 'card drip-signup-card mb-2';
    card.innerHTML = `
        <div class="card-header">
            <div>
                <div class="drip-badge mb-1">Private Inbox</div>
                <div class="card-title">Reply Mailbox</div>
            </div>
        </div>
        <p class="text-secondary mb-2" style="max-width:none;">
            Claim a private inbox alias to give brokers instead of your own address. It becomes
            the contact address they keep on file and type into their forms, and it is where
            their replies and verification requests land - with pause and block controls and a
            private evidence trail readable only by you. The relay only ever emails you, never
            brokers.
        </p>
        <form id="relay-claim-form">
            <div class="form-group">
                <label class="form-label" for="relay-email">Where should we forward broker replies?</label>
                <input type="email" id="relay-email" class="form-input" required
                    value="${esc(pii && pii.email ? pii.email : '')}" placeholder="you@example.com">
                <div class="form-hint">Your real inbox. Brokers never see it - they only ever see the alias.</div>
            </div>
            <div id="relay-claim-error" class="text-sm" style="color:var(--color-danger); display:none; margin-bottom:0.75rem;"></div>
            <button type="submit" class="btn btn-primary" id="relay-claim-btn" style="width:100%;">
                Claim my Reply Mailbox
            </button>
        </form>
        <p class="text-sm text-muted mt-1" style="max-width:none;">
            A working tool and a contribution: your subscription keeps DataPurge free for
            everyone and covers costs and time, not profit.
            <a href="privacy.html">What we store</a>.
        </p>
    `;
    container.appendChild(card);

    card.querySelector('#relay-claim-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = card.querySelector('#relay-email').value.trim();
        const errorEl = card.querySelector('#relay-claim-error');
        const btn = card.querySelector('#relay-claim-btn');
        if (!email) {
            errorEl.textContent = 'Enter the inbox where replies should be forwarded.';
            errorEl.style.display = '';
            return;
        }
        btn.disabled = true;
        btn.textContent = 'Setting up...';
        errorEl.style.display = 'none';
        try {
            const data = await claim(email);
            if (data && data.checkout_url) {
                btn.textContent = 'Redirecting to checkout...';
                window.location.href = data.checkout_url;
                return;
            }
            // Dev mode: no Stripe, worker returns pending_confirm.
            card.innerHTML = `
                <div style="font-size:2rem; margin-bottom:0.75rem;">&#9993;</div>
                <h3 style="margin-bottom:0.5rem;">Check your inbox</h3>
                <p class="text-secondary" style="max-width:520px; margin:0 auto;">
                    We sent a confirmation link to <strong>${esc(email)}</strong>. Click it to
                    finish setting up your Reply Mailbox alias.
                </p>
            `;
            card.className = 'card drip-confirmation mb-2';
        } catch (err) {
            errorEl.textContent = err.message || 'Something went wrong. Please try again.';
            errorEl.style.display = '';
            btn.disabled = false;
            btn.textContent = 'Claim my Reply Mailbox';
        }
    });
}

function buildActiveCard(container) {
    const state = getRelayState();
    const alias = state.alias;
    const needsBackup = !state.keyBackedUp;

    const card = document.createElement('div');
    card.className = 'card drip-signup-card mb-2';
    card.innerHTML = `
        <div class="card-header">
            <div>
                <div class="drip-badge mb-1">Active</div>
                <div class="card-title">Reply Mailbox</div>
            </div>
        </div>

        <p class="text-sm text-secondary mb-1" style="max-width:none;">
            Give brokers this alias instead of your own address. Replies and verification
            requests forward to your real inbox and appear in your Progress tab.
        </p>
        <div class="flex items-center" style="gap:0.5rem; flex-wrap:wrap; margin-bottom:0.75rem;">
            <code style="font-size:0.95rem; word-break:break-all;">${esc(alias)}</code>
            <button class="btn btn-outline btn-sm" id="relay-copy-btn">Copy</button>
        </div>
        <div class="text-sm text-muted mb-2" id="relay-status-line" style="max-width:none;"></div>

        ${needsBackup ? `
        <div class="callout callout-action" style="text-align:left; margin-bottom:0.75rem;">
            <h3 style="margin-bottom:0.5rem;">Save your key backup</h3>
            <p class="text-secondary text-sm" style="max-width:none;">
                Stored replies are sealed to a key that only this browser holds. Download the
                one-time backup now so you can still read them if you lose this browser. We
                cannot recover it for you.
            </p>
            <button class="btn btn-primary btn-sm mt-1" id="relay-backup-btn">Download key backup</button>
        </div>
        ` : ''}

        <div class="btn-group" style="flex-wrap:wrap; gap:0.5rem;">
            <button class="btn btn-primary btn-sm" id="relay-use-btn">Use as my opt-out contact email</button>
            <button class="btn btn-outline btn-sm" id="relay-evidence-btn">View stored replies</button>
            <button class="btn btn-outline btn-sm" id="relay-pause-btn" data-paused="0">Pause alias</button>
            <button class="btn btn-danger btn-sm" id="relay-delete-btn">Delete</button>
        </div>
        ${needsBackup ? '' : `
        <p class="text-sm text-muted mt-1" style="max-width:none;">
            Lost your device? <button class="btn-link text-sm" id="relay-rebackup-btn" style="background:none; border:none; color:var(--color-primary); cursor:pointer; padding:0; text-decoration:underline;">Download your key backup again</button>.
        </p>
        `}

        <div id="relay-evidence-panel" class="mt-2" style="display:none;"></div>
    `;
    container.appendChild(card);

    card.querySelector('#relay-copy-btn').addEventListener('click', () => {
        navigator.clipboard.writeText(alias)
            .then(() => showToast('Alias copied'))
            .catch(() => showToast('Copy failed - select the address manually'));
    });

    const backupBtn = card.querySelector('#relay-backup-btn');
    if (backupBtn) {
        backupBtn.addEventListener('click', () => {
            if (downloadKeyBackup()) {
                showToast('Key backup downloaded - store it somewhere safe');
                renderProfileCard(container);
            }
        });
    }
    const rebackupBtn = card.querySelector('#relay-rebackup-btn');
    if (rebackupBtn) {
        rebackupBtn.addEventListener('click', () => {
            if (downloadKeyBackup()) showToast('Key backup downloaded');
        });
    }

    card.querySelector('#relay-use-btn').addEventListener('click', () => {
        Store.applyRelayAlias(alias);
        showToast('Your opt-out contact email is now the alias');
        // Honesty: mailto batches still show the user's own sending address as From.
        renderProfileCard(container);
    });

    card.querySelector('#relay-evidence-btn').addEventListener('click', () => {
        const panel = card.querySelector('#relay-evidence-panel');
        if (panel.style.display !== 'none') {
            panel.style.display = 'none';
            return;
        }
        panel.style.display = '';
        renderEvidenceViewer(panel);
    });

    const pauseBtn = card.querySelector('#relay-pause-btn');
    pauseBtn.addEventListener('click', async () => {
        const paused = pauseBtn.dataset.paused === '1';
        pauseBtn.disabled = true;
        try {
            await updateSettings({ paused: !paused });
            showToast(!paused ? 'Alias paused' : 'Alias resumed');
            await refreshAliasStatus(card);
        } catch (err) {
            showToast(err.message || 'Could not update the alias');
        } finally {
            pauseBtn.disabled = false;
        }
    });

    card.querySelector('#relay-delete-btn').addEventListener('click', async () => {
        if (!confirm('Delete your Reply Mailbox alias? This permanently erases the alias, all stored replies and their evidence. This cannot be undone.')) return;
        try {
            await deleteAlias();
            showToast('Reply Mailbox deleted');
            renderProfileCard(container);
        } catch (err) {
            showToast(err.message || 'Could not delete the alias');
        }
    });

    // Populate live status (paused state, monthly count, paid-until) in the background.
    refreshAliasStatus(card);
}

async function refreshAliasStatus(card) {
    let info;
    try { info = await getAlias(); }
    catch { info = null; }
    if (!info) return;

    const paused = info.status === 'paused' || info.paused === true;
    const pauseBtn = card.querySelector('#relay-pause-btn');
    if (pauseBtn) {
        pauseBtn.dataset.paused = paused ? '1' : '0';
        pauseBtn.textContent = paused ? 'Resume alias' : 'Pause alias';
    }
    const statusEl = card.querySelector('#relay-status-line');
    if (statusEl) {
        const bits = [];
        if (info.status) bits.push(`Status: ${esc(info.status)}`);
        if (typeof info.relay_count_month === 'number') bits.push(`${info.relay_count_month} replies this month`);
        if (info.paid_until) {
            const d = new Date(info.paid_until);
            if (!isNaN(d)) bits.push(`Paid until ${d.toLocaleDateString()}`);
        }
        statusEl.innerHTML = bits.join(' &middot; ');
    }
}

async function renderEvidenceViewer(panel) {
    if (!isConfigured() || !isActive()) {
        panel.innerHTML = '<p class="text-sm text-secondary">Stored replies are not available yet.</p>';
        return;
    }
    panel.innerHTML = '<p class="text-sm text-secondary">Loading stored replies...</p>';
    let data;
    try {
        const auth = authHeader();
        const resp = await fetch(`${RELAY_API_URL}/api/replies`, { headers: { Authorization: auth } });
        if (!resp.ok) throw new Error(`Could not load replies (${resp.status}).`);
        data = await resp.json();
    } catch (err) {
        panel.innerHTML = `<p class="text-sm" style="color:var(--color-danger);">${esc(err.message || 'Could not load replies.')}</p>`;
        return;
    }

    const replies = (data && Array.isArray(data.replies)) ? data.replies : [];
    if (!replies.length) {
        panel.innerHTML = '<p class="text-sm text-secondary">No broker replies stored yet.</p>';
        return;
    }

    panel.innerHTML = replies.map(r => `
        <div class="evidence-row" style="border-top:1px solid var(--color-border); padding-top:0.5rem; margin-top:0.5rem;">
            <div class="progress-item">
                <div>
                    <span class="progress-item-name">${esc(r.subject || '(no subject)')}</span>
                    <span class="text-sm text-muted"> - ${esc(r.sender_domain || '')} &middot; ${esc(classificationLabel(r.classification))}</span>
                </div>
                <button class="btn btn-outline btn-sm btn-read-evidence" data-reply-id="${esc(r.id)}">Read</button>
            </div>
            <pre class="evidence-body" style="display:none; white-space:pre-wrap; word-break:break-word; font-size:0.85rem; margin-top:0.5rem;"></pre>
        </div>
    `).join('');

    panel.querySelectorAll('.btn-read-evidence').forEach(btn => {
        btn.addEventListener('click', async () => {
            const row = btn.closest('.evidence-row');
            const body = row.querySelector('.evidence-body');
            if (body.style.display !== 'none') {
                body.style.display = 'none';
                return;
            }
            body.style.display = '';
            body.textContent = 'Decrypting...';
            try {
                const evidence = await fetchEvidence(btn.dataset.replyId);
                const msg = await decryptEvidence(evidence);
                body.textContent =
                    `From: ${msg.from || ''}\n` +
                    `Subject: ${msg.subject || ''}\n` +
                    `Received: ${msg.received_at || ''}\n\n` +
                    (msg.text || '(no text body)');
            } catch (err) {
                body.textContent = err.message || 'Could not decrypt this message.';
            }
        });
    });
}

function renderProfileCard(container) {
    if (!container) return;
    container.innerHTML = '';
    if (!RELAY_LIVE) {
        container.appendChild(buildPreviewCard());
        return;
    }
    const state = getRelayState();
    if (state && state.notice) {
        const note = document.createElement('div');
        note.className = 'callout mt-1';
        note.innerHTML = `<p class="text-sm">${esc(state.notice)}</p>`;
        container.appendChild(note);
        saveRelayState({ ...state, notice: null });
    }
    if (isActive()) buildActiveCard(container);
    else buildClaimCard(container);
}

export const Relay = {
    // State / helpers
    isLive: () => RELAY_LIVE,
    isActive,
    getActiveAlias,
    classificationLabel,
    captureFragmentToken,

    // API
    claim,
    syncReplies,
    fetchEvidence,
    decryptEvidence,
    getAlias,
    updateSettings,
    deleteAlias,
    downloadKeyBackup,

    // Rendering
    renderProfileCard,
    renderQueueEntryPoint,
};
