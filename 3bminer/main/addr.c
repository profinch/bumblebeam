#include "addr.h"
#include <string.h>
#include <ctype.h>
static int bech32_program(const char *a, uint8_t out[40]) {
    static const char CS[] = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    const char *sep = strrchr(a, '1'); if (!sep || sep == a) return 0;
    size_t dl = strlen(sep + 1); if (dl < 8 || dl > 90) return 0;
    uint8_t v[90]; for (size_t i = 0; i < dl; i++) { const char *p = strchr(CS, tolower((unsigned char)sep[1 + i])); if (!p) return 0; v[i] = p - CS; }
    // v[0] = witness version, then the program in 5-bit groups, then 6 checksum groups
    uint32_t acc = 0; int bits = 0, n = 0;
    for (size_t i = 1; i < dl - 6; i++) { acc = (acc << 5) | v[i]; bits += 5; while (bits >= 8) { bits -= 8; if (n >= 40) return 0; out[n++] = (acc >> bits) & 0xff; } }
    return (n == 20 || n == 32) ? n : 0;
}
static int base58_program(const char *a, uint8_t out[40]) {
    static const char A[] = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    uint8_t b[25] = {0};
    for (const char *c = a; *c; c++) {
        const char *p = strchr(A, *c); if (!p) return 0; int carry = p - A;
        for (int i = 24; i >= 0; i--) { carry += 58 * b[i]; b[i] = carry & 0xff; carry >>= 8; }
        if (carry) return 0;
    }
    memcpy(out, b + 1, 20); return 20;   // version byte, hash160, 4-byte checksum
}
int addr_program(const char *addr, uint8_t out[40]) {
    if (!addr || !*addr) return 0;
    if (!strncasecmp(addr, "bc1", 3) || !strncasecmp(addr, "tb1", 3)) return bech32_program(addr, out);
    return base58_program(addr, out);
}
bool addr_in(const uint8_t *buf, size_t n, const uint8_t *prog, int plen) {
    if (plen <= 0) return false;
    for (size_t i = 0; i + plen <= n; i++) if (buf[i] == prog[0] && !memcmp(buf + i, prog, plen)) return true;
    return false;
}
