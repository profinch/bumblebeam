#include "addr.h"
#include "sha256.h"
#include <string.h>
#include <ctype.h>
// bech32 (BIP173, witness v0) and bech32m (BIP350, v1+): hrp bc/tb, checksum, program length and padding all checked
static uint32_t polymod(const uint8_t *v, size_t n) {
    static const uint32_t G[5] = { 0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3 };
    uint32_t c = 1; for (size_t i = 0; i < n; i++) { uint8_t b = c >> 25; c = ((c & 0x1ffffff) << 5) ^ v[i]; for (int k = 0; k < 5; k++) if ((b >> k) & 1) c ^= G[k]; }
    return c;
}
static int segwit_script(const char *a, uint8_t out[ADDR_SCRIPT_MAX]) {
    static const char CS[] = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    size_t len = strlen(a); if (len < 14 || len > 90) return 0;
    bool lo = false, up = false; for (size_t i = 0; i < len; i++) { if (islower((unsigned char)a[i])) lo = true; if (isupper((unsigned char)a[i])) up = true; }
    if (lo && up) return 0;
    const char *sep = strrchr(a, '1'); if (!sep) return 0; size_t hl = sep - a, dl = len - hl - 1;
    if (hl != 2 || dl < 7) return 0;
    uint8_t v[2 * 2 + 1 + 90]; size_t n = 0;   // expanded hrp, then the data part
    for (size_t i = 0; i < hl; i++) v[n++] = tolower((unsigned char)a[i]) >> 5;
    v[n++] = 0; for (size_t i = 0; i < hl; i++) v[n++] = tolower((unsigned char)a[i]) & 31;
    const uint8_t *d = v + n;
    for (size_t i = 0; i < dl; i++) { const char *p = strchr(CS, tolower((unsigned char)sep[1 + i])); if (!p || !*p) return 0; v[n++] = p - CS; }
    uint32_t pm = polymod(v, n); int ver = d[0]; if (ver > 16) return 0;
    if (pm != (ver == 0 ? 1u : 0x2bc830a3u)) return 0;   // v0 must be bech32, v1+ bech32m
    // the program: 5-bit groups after the version, minus the 6 checksum groups, regrouped to bytes with zero padding
    uint8_t prog[40]; int pl = 0; uint32_t acc = 0; int bits = 0;
    for (size_t i = 1; i < dl - 6; i++) { acc = (acc << 5) | d[i]; bits += 5; while (bits >= 8) { bits -= 8; if (pl >= 40) return 0; prog[pl++] = (acc >> bits) & 0xff; } }
    if (bits >= 5 || (acc & ((1u << bits) - 1))) return 0;
    if (pl < 2 || (ver == 0 && pl != 20 && pl != 32)) return 0;
    out[0] = ver ? 0x50 + ver : 0; out[1] = pl; memcpy(out + 2, prog, pl); return pl + 2;   // OP_n <push program>
}
// base58check: 25 bytes, the last 4 the first 4 of sha256d of the other 21; version 0x00/0x6f P2PKH, 0x05/0xc4 P2SH
static int base58_script(const char *a, uint8_t out[ADDR_SCRIPT_MAX]) {
    static const char A[] = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    size_t len = strlen(a); if (len < 26 || len > 35) return 0;
    uint8_t b[25] = {0};
    for (const char *c = a; *c; c++) {
        const char *p = strchr(A, *c); if (!p || !*p) return 0; int carry = p - A;
        for (int i = 24; i >= 0; i--) { carry += 58 * b[i]; b[i] = carry & 0xff; carry >>= 8; }
        if (carry) return 0;
    }
    uint8_t h[32]; sha256d_raw(b, 21, h); if (memcmp(h, b + 21, 4)) return 0;
    if (b[0] == 0x00 || b[0] == 0x6f) { const uint8_t s[] = { 0x76, 0xa9, 0x14 }; memcpy(out, s, 3); memcpy(out + 3, b + 1, 20); out[23] = 0x88; out[24] = 0xac; return 25; }
    if (b[0] == 0x05 || b[0] == 0xc4) { out[0] = 0xa9; out[1] = 0x14; memcpy(out + 2, b + 1, 20); out[22] = 0x87; return 23; }
    return 0;
}
int addr_script(const char *addr, uint8_t out[ADDR_SCRIPT_MAX]) {
    if (!addr || !*addr) return 0;
    if (!strncasecmp(addr, "bc1", 3) || !strncasecmp(addr, "tb1", 3)) return segwit_script(addr, out);
    return base58_script(addr, out);
}
// Bitcoin's CompactSize; false past the end
static bool varint(const uint8_t *b, size_t n, size_t *i, uint64_t *v) {
    if (*i >= n) return false;
    uint8_t f = b[(*i)++]; int k = f < 0xfd ? 0 : f == 0xfd ? 2 : f == 0xfe ? 4 : 8;
    if (!k) { *v = f; return true; }
    if (*i + k > n) return false;
    *v = 0; for (int j = 0; j < k; j++) *v |= (uint64_t)b[*i + j] << (8 * j); *i += k; return true;
}
int addr_coinbase_share(const uint8_t *tx, size_t n, const uint8_t *script, int slen) {
    if (slen <= 0) return -1;
    size_t i = 4; uint64_t cnt, l;   // version
    if (!varint(tx, n, &i, &cnt) || cnt != 1) return -1;   // one input: the coinbase
    i += 36; if (!varint(tx, n, &i, &l) || i + l + 4 > n) return -1; i += l + 4;   // prevout, script, sequence
    if (!varint(tx, n, &i, &cnt) || cnt == 0 || cnt > 1000) return -1;
    uint64_t total = 0, ours = 0;
    for (uint64_t k = 0; k < cnt; k++) {
        if (i + 8 > n) return -1;
        uint64_t v = 0; for (int j = 0; j < 8; j++) v |= (uint64_t)tx[i + j] << (8 * j);
        i += 8;
        if (!varint(tx, n, &i, &l) || i + l > n) return -1;
        total += v; if (l == (uint64_t)slen && !memcmp(tx + i, script, slen)) ours += v;
        i += l;
    }
    return total ? (int)(ours * 100 / total) : 0;
}
