// node pool/web/test/walletkey.test.mjs - the admin page's wallet-id extraction (linked miners "same wallet")
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const src = readFileSync(new URL('../dash.js', import.meta.url), 'utf8');
const block = src.match(/const B58 = [\s\S]*?\n  }\n/)[0];
const { walletKey, B58 } = new Function(`${block}; return { walletKey, B58 };`)();
const b58 = (bytes) => { let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } return s; };
const key = Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 255);
const keyHex = key.map((b) => b.toString(16).padStart(2, '0')).join('');
// a regular address is the SBBS id itself: channel (hex, no leading zeros) + 32-byte key
assert.equal(walletKey(`3bf${keyHex}`), `3bf:${keyHex}`);
assert.equal(walletKey(`3BF${keyHex.toUpperCase()}`), `3bf:${keyHex}`, 'case does not matter');
// an offline / regular-new token carries it after a 0xa8 length byte: an 8-byte channel, then the key
const token = b58([0x80, 0x00, 0x86, 0x01, 0x00, 0x82, 0x01, 0x07, 0x01, 0x07, 0xa8, 0, 0, 0, 0, 0, 0, 0x03, 0xbf, ...key, ...Array(60).fill(9)]);
assert.ok(token.length >= 90, `token ${token.length} chars`);
assert.equal(walletKey(token), `3bf:${keyHex}`, 'the offline token names the same wallet as the regular address');
// a public-offline / max-privacy token carries none
assert.equal(walletKey(b58([0x80, 0x00, 0x85, 0x01, 0x00, 0x82, 0x01, 0x07, 0x01, 0x15, 0xa0, ...Array(120).fill(5)])), null);
assert.equal(walletKey('not an address'), null);
console.log('walletKey: ok');
