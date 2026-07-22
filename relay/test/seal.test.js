import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, open, generateRecipientKeypair, b64decode, b64encode } from '../src/seal.js';

const SAMPLE = JSON.stringify({
    text: 'We have received your request. Reference DSR-1001.',
    html: '<p>We have received your request.</p>',
    from: 'privacy@examplebroker.com',
    subject: 'Re: Data deletion request',
    received_at: '2026-07-20T09:00:00.000Z',
});

test('seal/open round-trips a message', async () => {
    const { pubRawB64, privateJwk } = await generateRecipientKeypair();
    const sealed = await seal(SAMPLE, pubRawB64);
    assert.equal(typeof sealed, 'string');
    const opened = await open(sealed, privateJwk);
    assert.equal(opened, SAMPLE);
});

test('each seal uses a fresh ephemeral key (ciphertexts differ)', async () => {
    const { pubRawB64, privateJwk } = await generateRecipientKeypair();
    const a = await seal(SAMPLE, pubRawB64);
    const b = await seal(SAMPLE, pubRawB64);
    assert.notEqual(a, b);
    assert.equal(await open(a, privateJwk), SAMPLE);
    assert.equal(await open(b, privateJwk), SAMPLE);
});

test('tampering with the ciphertext fails to open', async () => {
    const { pubRawB64, privateJwk } = await generateRecipientKeypair();
    const sealed = await seal(SAMPLE, pubRawB64);
    const bytes = b64decode(sealed);
    bytes[bytes.length - 1] ^= 0x01; // flip a bit in the GCM tag
    const tampered = b64encode(bytes);
    await assert.rejects(() => open(tampered, privateJwk));
});

test('opening with the wrong private key fails', async () => {
    const recipient = await generateRecipientKeypair();
    const attacker = await generateRecipientKeypair();
    const sealed = await seal(SAMPLE, recipient.pubRawB64);
    await assert.rejects(() => open(sealed, attacker.privateJwk));
});

test('a truncated payload is rejected', async () => {
    const { privateJwk } = await generateRecipientKeypair();
    await assert.rejects(() => open(b64encode(new Uint8Array(10)), privateJwk));
});

test('seal accepts a base64url-encoded public key (app upload format)', async () => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const b64url = Buffer.from(raw).toString('base64url');
    assert.match(b64url, /[-_]|^[A-Za-z0-9]+$/);
    const sealed = await seal('base64url probe', b64url);
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    assert.equal(await open(sealed, jwk), 'base64url probe');
});
