#include "job.h"
#include "sha256.h"
#include <string.h>
#include <stdio.h>
#include <math.h>
static int hv(char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1; }
int hex2bin(const char *hex, uint8_t *out, int maxlen) { int n = 0; while (hex[0] && hex[1] && n < maxlen) { int a = hv(hex[0]), b = hv(hex[1]); if (a < 0 || b < 0) return -1; out[n++] = a * 16 + b; hex += 2; } return n; }
void bin2hex(const uint8_t *b, int n, char *out) { static const char *h = "0123456789abcdef"; for (int i = 0; i < n; i++) { out[2*i] = h[b[i] >> 4]; out[2*i+1] = h[b[i] & 15]; } out[2*n] = 0; }
static inline uint32_t be32(const uint8_t *p) { return ((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|((uint32_t)p[2]<<8)|p[3]; }
void job_build_words(const job_t *j, const session_t *s, uint32_t en2, uint32_t w[19]) {
    uint8_t cb[4096]; int n = 0;
    memcpy(cb, j->coinb1, j->coinb1_len); n += j->coinb1_len;
    memcpy(cb + n, s->extranonce1, s->en1_len); n += s->en1_len;
    for (int i = 0; i < s->en2_size; i++) cb[n++] = (i < 4) ? (en2 >> (8 * i)) & 0xff : 0;   // little-endian counter
    memcpy(cb + n, j->coinb2, j->coinb2_len); n += j->coinb2_len;
    uint8_t root[32]; sha256d_raw(cb, n, root);
    for (int i = 0; i < j->nbranch; i++) { uint8_t t[64]; memcpy(t, root, 32); memcpy(t + 32, j->branch[i], 32); sha256d_raw(t, 64, root); }
    w[0] = __builtin_bswap32(j->version);
    for (int i = 0; i < 8; i++) w[1 + i] = j->prevhash_w[i];
    for (int i = 0; i < 8; i++) w[9 + i] = be32(root + 4 * i);
    w[17] = __builtin_bswap32(j->ntime);
    w[18] = __builtin_bswap32(j->nbits);
}
void job_hash(const uint32_t w[19], uint32_t nonce_word, uint32_t H[8]) {
    uint32_t st[8]; memcpy(st, SHA256_IV, 32); sha256_compress(st, w);
    uint32_t b2[16] = { w[16], w[17], w[18], nonce_word, 0x80000000u, 0,0,0,0,0,0,0,0,0,0, 640 }; sha256_compress(st, b2);
    uint32_t m2[16] = {0}; memcpy(m2, st, 32); m2[8] = 0x80000000u; m2[15] = 256;
    memcpy(H, SHA256_IV, 32); sha256_compress(H, m2);
}
double job_diff(const uint32_t H[8]) {
    // hash as little-endian 256-bit number: most significant word = bswap(H[7]) ... least = bswap(H[0])
    double v = 0; for (int i = 7; i >= 0; i--) v = v * 4294967296.0 + (double)__builtin_bswap32(H[i]);
    if (v <= 0) return 1e300;
    return (65535.0 * ldexp(1.0, 208)) / v;
}
