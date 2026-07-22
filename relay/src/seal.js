/**
 * DataPurge Reply Mailbox - sealed-box evidence encryption.
 *
 * PURE WebCrypto ECIES. Runs unchanged in Cloudflare Workers and in Node 19+
 * (both expose globalThis.crypto.subtle), so the same code seals in the Worker
 * and the test suite round-trips it under plain `node`.
 *
 * Wire format (all binary, then base64):
 *   ephemeralPublicKeyRaw(65) || iv(12) || aesGcmCiphertext(...)
 *
 * Scheme: ECDH P-256 with a fresh ephemeral key per message, HKDF-SHA256
 * (empty salt, info "datapurge-relay-v1") to derive a 256-bit key, then
 * AES-256-GCM. Only the recipient's private key can recover the plaintext;
 * the Worker holds only the public key, so it can seal but never open.
 */

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const HKDF_INFO = ENC.encode('datapurge-relay-v1');
const EPH_LEN = 65; // uncompressed P-256 point
const IV_LEN = 12;

function subtle() {
    return globalThis.crypto.subtle;
}

// --- base64 helpers (no Buffer; btoa/atob work in Workers and Node) ---

export function b64encode(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < arr.length; i += chunk) {
        bin += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
    }
    return btoa(bin);
}

export function b64decode(b64) {
    // Accept both standard base64 and base64url (the app uploads public keys
    // base64url-encoded); atob only understands the standard alphabet.
    let s = String(b64).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function deriveAesKey(sharedBits, usages) {
    const hkdfKey = await subtle().importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
    return subtle().deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: HKDF_INFO },
        hkdfKey,
        { name: 'AES-GCM', length: 256 },
        false,
        usages,
    );
}

/**
 * Seal a UTF-8 string to a recipient's raw P-256 public key (base64).
 * Returns base64(ephemeralPubRaw || iv || ciphertext).
 */
export async function seal(plaintextString, recipientPubRawB64) {
    const recipientPub = await subtle().importKey(
        'raw', b64decode(recipientPubRawB64),
        { name: 'ECDH', namedCurve: 'P-256' }, false, [],
    );
    const ephemeral = await subtle().generateKey(
        { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
    );
    const shared = await subtle().deriveBits(
        { name: 'ECDH', public: recipientPub }, ephemeral.privateKey, 256,
    );
    const aesKey = await deriveAesKey(shared, ['encrypt']);
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN));
    const ct = new Uint8Array(
        await subtle().encrypt({ name: 'AES-GCM', iv }, aesKey, ENC.encode(String(plaintextString))),
    );
    const ephPubRaw = new Uint8Array(await subtle().exportKey('raw', ephemeral.publicKey));

    const out = new Uint8Array(ephPubRaw.length + iv.length + ct.length);
    out.set(ephPubRaw, 0);
    out.set(iv, ephPubRaw.length);
    out.set(ct, ephPubRaw.length + iv.length);
    return b64encode(out);
}

/**
 * Open a sealed payload with the recipient's private key (JWK form).
 * Used by the tests and by the in-browser evidence viewer for parity.
 * Throws if the payload is malformed, tampered, or sealed to another key.
 */
export async function open(sealedB64, privateKeyJwk) {
    const bytes = b64decode(sealedB64);
    if (bytes.length < EPH_LEN + IV_LEN + 16) throw new Error('sealed payload too short');
    const ephPubRaw = bytes.subarray(0, EPH_LEN);
    const iv = bytes.subarray(EPH_LEN, EPH_LEN + IV_LEN);
    const ct = bytes.subarray(EPH_LEN + IV_LEN);

    const ephPub = await subtle().importKey(
        'raw', ephPubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
    );
    const priv = await subtle().importKey(
        'jwk', privateKeyJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'],
    );
    const shared = await subtle().deriveBits({ name: 'ECDH', public: ephPub }, priv, 256);
    const aesKey = await deriveAesKey(shared, ['decrypt']);
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv }, aesKey, ct);
    return DEC.decode(pt);
}

/**
 * Generate a recipient keypair. The app does this client-side and uploads only
 * pubRawB64; exposed here so tests and the browser share one implementation.
 */
export async function generateRecipientKeypair() {
    const kp = await subtle().generateKey(
        { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
    );
    const pubRaw = new Uint8Array(await subtle().exportKey('raw', kp.publicKey));
    const privateJwk = await subtle().exportKey('jwk', kp.privateKey);
    return { pubRawB64: b64encode(pubRaw), privateJwk };
}
