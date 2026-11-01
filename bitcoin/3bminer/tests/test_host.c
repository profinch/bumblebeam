// Host tests for the firmware code that needs no hardware: addresses (addr.c), coinbase parsing, request checks (netcheck.c),
// hex parsing (job.c), the header hash against the genesis block. Run: tests/run.sh
#include "addr.h"
#include "netcheck.h"
#include "job.h"
#include "sha256.h"
#include <stdio.h>
#include <string.h>
#include "vectors.h"
static int fails, checks;
#define CHECK(c, ...) do { checks++; if (!(c)) { fails++; printf("FAIL %s:%d: ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)
static int unhex(const char *h, uint8_t *b, int cap) { return hex2bin(h, b, cap); }
int main(void) {
    for (size_t i = 0; i < sizeof GOOD / sizeof *GOOD; i++) {
        uint8_t s[ADDR_SCRIPT_MAX]; char hx[2 * ADDR_SCRIPT_MAX + 1]; int n = addr_script(GOOD[i].a, s); bin2hex(s, n > 0 ? n : 0, hx);
        CHECK(n > 0, "address refused: %s", GOOD[i].a);
        if (GOOD[i].script) CHECK(!strcmp(hx, GOOD[i].script), "%s -> %s, want %s", GOOD[i].a, hx, GOOD[i].script);
    }
    for (size_t i = 0; i < sizeof BAD / sizeof *BAD; i++) { uint8_t s[ADDR_SCRIPT_MAX]; CHECK(addr_script(BAD[i], s) == 0, "bad address taken: %s", BAD[i]); }
    uint8_t spk[64]; int sl = unhex(SPK, spk, sizeof spk);
    for (size_t i = 0; i < sizeof CB / sizeof *CB; i++) { static uint8_t t[4096]; int n = unhex(CB[i].tx, t, sizeof t);
        int p = addr_coinbase_share(t, n, spk, sl); CHECK(p == CB[i].pct, "coinbase %u: %d%%, want %d%%", (unsigned)i, p, CB[i].pct); }
    // request checks
    const struct { const char *h; int lan, local; } H[] = { { "192.168.0.21", 1, 0 }, { "10.0.0.1", 1, 0 }, { "172.16.5.4", 1, 0 }, { "172.32.0.1", 0, 0 },
        { "8.8.8.8", 0, 0 }, { "10.1.evil.com", 0, 0 }, { "192.168.evil.com", 0, 0 }, { "10.1.2.3.evil.com", 0, 0 }, { "256.1.1.1", 0, 0 }, { "1.2.3.4x", 0, 0 },
        { "localhost", 1, 1 }, { "3bminer-000001", 1, 1 }, { "devkit.lan", 1, 1 }, { "x.home.arpa", 1, 1 }, { "a.local", 1, 1 }, { "evil.com", 0, 0 }, { "", 0, 0 } };
    for (size_t i = 0; i < sizeof H / sizeof *H; i++) { unsigned a, b; CHECK(net_lan_host(H[i].h) == H[i].lan, "lan_host(%s)", H[i].h); CHECK(net_local_name(H[i].h) == H[i].local, "local_name(%s)", H[i].h); (void)a; (void)b; }
    char host[72], l63[64]; memset(l63, 'a', 63); l63[63] = 0; char o[200];
    snprintf(o, sizeof o, "http://%s.ev.io", l63); CHECK(!net_url_host(o, host, 64), "63-char label cut to a bare name");
    CHECK(net_url_host(o, host, sizeof host) && !net_lan_host(host), "63-char label .ev.io counted as LAN");
    CHECK(!net_url_host("http://[2606:4700::1]", host, sizeof host), "IPv6 origin taken");
    CHECK(net_url_host("http://192.168.0.21:8080/x", host, sizeof host) && !strcmp(host, "192.168.0.21"), "origin host");
    CHECK(!net_url_host("null", host, sizeof host), "null origin");
    char hp[32]; strcpy(hp, "192.168.0.21:80"); CHECK(net_host_part(hp) && !strcmp(hp, "192.168.0.21"), "host part");
    strcpy(hp, "[::1]:80"); CHECK(!net_host_part(hp), "IPv6 host");
    char deep[1100]; memset(deep, '[', 1000); deep[1000] = 0; CHECK(!net_json_depth_ok(deep, 6), "deep json");
    CHECK(net_json_depth_ok("{\"params\":[\"a\",[\"b\"],\"[[[[[[[\"]}", 3), "brackets in strings counted");
    CHECK(net_json_depth_ok("{\"a\":\"\\\"[[[[[[\"}", 1), "escaped quote");
    // hex: whole bytes only
    uint8_t b[4]; CHECK(hex2bin("0a0B", b, 4) == 2 && b[1] == 11, "hex"); CHECK(hex2bin("0a0", b, 4) < 0, "odd hex"); CHECK(hex2bin("zz", b, 4) < 0, "not hex"); CHECK(hex2bin("0102030405", b, 4) < 0, "too long");
    // the genesis header hashes to its known hash (job_hash on header words, difficulty > 1)
    static const char *G = "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c";
    uint8_t g[80]; unhex(G, g, 80); uint32_t w[19], H8[8]; for (int i = 0; i < 19; i++) w[i] = (uint32_t)g[4*i] << 24 | g[4*i+1] << 16 | g[4*i+2] << 8 | g[4*i+3];
    uint32_t nw = (uint32_t)g[76] << 24 | g[77] << 16 | g[78] << 8 | g[79]; job_hash(w, nw, H8);
    CHECK(__builtin_bswap32(H8[7]) == 0x00000000u && __builtin_bswap32(H8[6]) == 0x0019d668u, "genesis hash %08x%08x", (unsigned)__builtin_bswap32(H8[7]), (unsigned)__builtin_bswap32(H8[6]));
    double d = job_diff(H8); CHECK(d > 2000 && d < 3000, "genesis difficulty %.1f", d);
    printf("%d checks, %d failed\n", checks, fails); return fails != 0;
}
