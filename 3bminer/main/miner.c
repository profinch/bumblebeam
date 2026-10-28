// core 0: drives the SHA engine kernel with interrupts disabled in chunks
#include "miner.h"
#include "stratum.h"
#include "job.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_cpu.h"
#include "esp_private/periph_ctrl.h"
#include "soc/periph_defs.h"
#include <string.h>
#include <math.h>
#include "sha256.h"
#include "esp_heap_caps.h"
static const char *TAG = "miner";
miner_stats_t g_miner;
extern uint32_t hwmine(uint32_t *tbl, uint32_t nonce_start, uint32_t count, uint32_t E, uint32_t d2);
// mine2.S (tools/gen_mine2.py): START of block 1 after K header words + deferred hit test; same interface
extern uint32_t hwmine_k6(uint32_t *, uint32_t, uint32_t, uint32_t, uint32_t);
typedef uint32_t (*kernel_fn)(uint32_t *, uint32_t, uint32_t, uint32_t, uint32_t);
// the index is the API's kernel number (info "kernel", /api/bench?k=); 1, 2, 4, 5 were k8, k7, k5, k4, no longer built (1.3 KB of IRAM)
static const kernel_fn s_kernels[] = { hwmine, NULL, NULL, hwmine_k6 };
#define NKERNELS (sizeof s_kernels / sizeof s_kernels[0])
bool miner_kernel_ok(uint32_t k) { return k < NKERNELS && s_kernels[k]; }
// hwmine_k6 (index 3): START after 6 words + deferred hit test. Swept: W1 passes 23..40, W2 >= 35, W3 >= 22, L1 >= 3, L2 8 (reads word 7 one cycle
// earlier than hwmine, so L2 needs +1); 25/36/23/6/8 = 251.7 bench cycles/nonce, misses at the same ~1 per 4-30M noise level as hwmine.
// k5/k4 (START after 5 or 4 words) never pass: the stores lose the race against the engine reading W[i].
volatile uint32_t g_kernel = 3;
volatile uint32_t g_sw_enabled = 1;   // core-1 software hasher on/off (A/B against the engine rate)
#define ENGINE_E 68
#define LOAD_D2  8
#define CHUNK    16384
static uint32_t DRAM_ATTR s_tbl[32];
static const uint8_t genesis[80] = {
    0x01,0x00,0x00,0x00, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0x3b,0xa3,0xed,0xfd,0x7a,0x7b,0x12,0xb2,0x7a,0xc7,0x2c,0x3e,0x67,0x76,0x8f,0x61,0x7f,0xc8,0x1b,0xc3,0x88,0x8a,0x51,0x32,0x3a,0x9f,0xb8,0xaa,0x4b,0x1e,0x5e,0x4a,
    0x29,0xab,0x5f,0x49, 0xff,0xff,0x00,0x1d, 0x1d,0xac,0x2b,0x7c };
bench_t g_bench;
// live per-stage waits (tbl[25..29]): before CONTINUE, before LOAD H1, before LOAD H2, settle after LOAD H1, after LOAD H2.
// Swept with /api/bench (fixed header, 8-bit mask, hit set vs a reference run): hard limits 30/35/22/3-4/6;
// 30/36/23/6/7 gave 0 errors in 64M nonces = 258.4 bench cycles/nonce vs 272.4 for the old uniform E=68/d2=8.
// 24/35/22/4/8 (0.7.1): over ~100M nonces each against 25/36/23/6/8, as few engine errors (2 to 4) and 5 cycles a nonce
// less (246.75 against 251.77); 23 for the first wait already gives 10-16 errors in 16M, 7 for the last breaks it
volatile uint32_t g_timing[5] = { 24, 35, 22, 4, 8 };   // live waits for g_kernel (hwmine itself: 30/36/23/6/7)
static void set_timing(const volatile uint32_t *t) { for (int i = 0; i < 5; i++) s_tbl[25 + i] = t[i]; }
static void run_bench(void) {
    // fixed header (genesis words) and an 8-bit mask: ~n/256 hits, each re-verified in software; the hit set must match a reference run
    uint32_t save[32]; memcpy(save, s_tbl, sizeof save);
    uint32_t w[19]; for (int i = 0; i < 19; i++) w[i] = s_tbl[i] = ((uint32_t)genesis[4*i] << 24) | ((uint32_t)genesis[4*i+1] << 16) | ((uint32_t)genesis[4*i+2] << 8) | genesis[4*i+3];
    s_tbl[23] = 0x000000FFu; set_timing(g_bench.t);
    uint32_t hits = 0, bad = 0, sum = 0; uint64_t cyc = 0; const uint32_t base = 0x40000000u, end = base + g_bench.n; uint32_t n = base;
    while (n < end) {
        uint32_t cnt = end - n < CHUNK ? end - n : CHUNK;
        s_tbl[24] = 0; portDISABLE_INTERRUPTS(); uint32_t c0 = esp_cpu_get_cycle_count(); uint32_t r = s_kernels[miner_kernel_ok(g_bench.k) ? g_bench.k : 0](s_tbl, n, cnt, ENGINE_E, LOAD_D2); cyc += esp_cpu_get_cycle_count() - c0; portENABLE_INTERRUPTS();
        if (s_tbl[24]) { uint32_t H[8]; job_hash(w, r, H); hits++; if (H[7] & 0xFF) bad++; sum = sum * 31 + r; n = r + 1; } else n = r;
        if ((hits & 63) == 0) taskYIELD();
        if (hits > (g_bench.n >> 6) + 64) { bad += 1000000; break; }   // broken timing reports ~every nonce as a hit: bail out instead of crawling
    }
    memcpy(s_tbl, save, sizeof save);
    g_bench.cyc_per_kn = (uint32_t)(cyc * 1000 / g_bench.n); g_bench.hits = hits; g_bench.bad = bad; g_bench.sum = sum;
    if (g_bench.apply && bad == 0) { for (int i = 0; i < 5; i++) g_timing[i] = g_bench.t[i]; if (miner_kernel_ok(g_bench.k)) g_kernel = g_bench.k; }
    set_timing(g_timing);
    ESP_LOGI(TAG, "bench k=%u t=%u/%u/%u/%u/%u n=%u: %u.%03u cyc/nonce hits %u bad %u sum %08x", (unsigned)g_bench.k, (unsigned)g_bench.t[0], (unsigned)g_bench.t[1], (unsigned)g_bench.t[2], (unsigned)g_bench.t[3], (unsigned)g_bench.t[4], (unsigned)g_bench.n, (unsigned)(g_bench.cyc_per_kn / 1000), (unsigned)(g_bench.cyc_per_kn % 1000), (unsigned)hits, (unsigned)bad, (unsigned)sum);
}
static uint32_t hit_mask_for(double pool_diff) {
    // a share needs >= 32 + floor(log2(diff)) leading zero bits of the hash number, whose top 32 bits are bswap(word7)
    int bits = 32 + (int)floor(log2(pool_diff > 0 ? pool_diff : 1e-9));
    if (bits >= 32) return 0xFFFFFFFFu;
    if (bits <= 8) return 0x000000FFu;
    return __builtin_bswap32(~(0xFFFFFFFFu >> bits));
}
static bool selftest(void) {
    for (int i = 0; i < 19; i++) s_tbl[i] = ((uint32_t)genesis[4*i] << 24) | ((uint32_t)genesis[4*i+1] << 16) | ((uint32_t)genesis[4*i+2] << 8) | genesis[4*i+3];
    s_tbl[23] = 0xFFFFFFFFu; const uint32_t tgt = 0x1dac2b7cu; uint32_t hits = 0, hitn = 0, cyc = 0, total = 0;
    for (uint32_t n0 = tgt - 100000; n0 < tgt + 100000; n0 += 20000) {
        uint32_t n = n0, endn = n0 + 20000;
        while (n < endn) { s_tbl[24] = 0; portDISABLE_INTERRUPTS(); uint32_t c0 = esp_cpu_get_cycle_count(); uint32_t r = s_kernels[g_kernel](s_tbl, n, endn - n, ENGINE_E, LOAD_D2); cyc += esp_cpu_get_cycle_count() - c0; portENABLE_INTERRUPTS(); if (s_tbl[24]) { hits++; hitn = r; n = r + 1; } else n = endn; }
        total += 20000; vTaskDelay(1);
    }
    bool ok = (hits == 1 && hitn == tgt);
    // single-nonce digest check: after hwmine returns, TEXT[0..7] holds H2 of the last nonce processed
    { uint32_t w[19]; for (int i = 0; i < 19; i++) w[i] = s_tbl[i]; uint32_t H[8]; job_hash(w, tgt, H);
      s_tbl[24] = 0; portDISABLE_INTERRUPTS(); uint32_t r = s_kernels[g_kernel](s_tbl, tgt, 1, ENGINE_E, LOAD_D2); portENABLE_INTERRUPTS();
      volatile uint32_t *T = (volatile uint32_t *)0x3ff03000; uint32_t E[8]; for (int i = 0; i < 8; i++) E[i] = T[i];
      ESP_LOGI(TAG, "single nonce: ret %08x hit %u | engine %08x %08x .. %08x | sw %08x %08x .. %08x", (unsigned)r, (unsigned)s_tbl[24], (unsigned)E[0], (unsigned)E[1], (unsigned)E[7], (unsigned)H[0], (unsigned)H[1], (unsigned)H[7]); }
    ESP_LOGI(TAG, "SELFTEST %s: %.1f cycles/nonce = %.1f KH/s (hits %u, nonce %08x)", ok ? "OK" : "WRONG", (double)cyc / total, 240000.0 * total / cyc, (unsigned)hits, (unsigned)hitn);
    return ok;
}
static void task(void *arg) {
    periph_module_enable(PERIPH_SHA_MODULE);
    s_tbl[19] = 0x80000000u; s_tbl[20] = 640; s_tbl[21] = 256; s_tbl[22] = 1; s_tbl[23] = 0xFFFFFFFFu; set_timing(g_timing);
    selftest();
    static job_t job; static session_t sess; uint32_t seq = 0; static uint32_t w[19]; uint32_t en2 = 0, nonce = 0; bool have = false;
    int64_t win_t = esp_timer_get_time(); uint64_t win_h = 0; g_miner.start_us = win_t;
    s_tbl[19] = 0x80000000u; s_tbl[20] = 640; s_tbl[21] = 256; s_tbl[22] = 1; s_tbl[23] = 0xFFFFFFFFu;
    for (;;) {
        if (g_bench.req) { g_bench.req = 0; run_bench(); g_bench.done = 1; }
        if (stratum_get_job(&job, &sess, &seq)) {
            en2 = (uint32_t)(esp_timer_get_time() & 0xffff) << 8;   // spread extranonce2 between restarts
            nonce = 0; job_build_words(&job, &sess, en2, w); memcpy(s_tbl, w, 19 * 4); have = true;
            ESP_LOGI(TAG, "new job seq %u en2 %08x", (unsigned)seq, (unsigned)en2);
        }
        if (!have || !g_stratum.connected) { have = have && g_stratum.connected; vTaskDelay(pdMS_TO_TICKS(100)); continue; }
        s_tbl[23] = hit_mask_for(g_stratum.pool_diff);
        uint32_t count = (0xFFFFFFFFu - nonce < CHUNK) ? (0xFFFFFFFFu - nonce) : CHUNK;
        if (count == 0) { en2++; nonce = 0; job_build_words(&job, &sess, en2, w); memcpy(s_tbl, w, 19 * 4); continue; }
        s_tbl[24] = 0;
        portDISABLE_INTERRUPTS();
        uint32_t c0 = esp_cpu_get_cycle_count();
        uint32_t r = s_kernels[g_kernel](s_tbl, nonce, count, ENGINE_E, LOAD_D2);
        uint32_t cyc = esp_cpu_get_cycle_count() - c0;
        portENABLE_INTERRUPTS();
        uint32_t done = (s_tbl[24] ? r + 1 : r) - nonce;
        win_h += done; g_miner.total_hashes += done; if (done) g_miner.kernel_cycles = cyc / done;
        if (s_tbl[24]) { candidate_t c = { .job_seq = seq, .en2 = en2, .nonce_word = r }; memcpy(c.w, w, sizeof w); stratum_submit_candidate(&c); g_miner.candidates++; nonce = r + 1; }
        else nonce = r;
        int64_t now = esp_timer_get_time();
        if (now - win_t >= 5000000) { g_miner.hashrate = (double)win_h * 1e6 / (now - win_t); win_t = now; win_h = 0; }
        if ((g_miner.total_hashes & 0xFFFFF) < done) taskYIELD();   // let core-0 housekeeping run occasionally
    }
}
// core 1: software sha256d in idle time, own extranonce2 range. A compact rolled SHA-256 (sha256.c, ~1 KB of code) with a
// midstate per job: it stays in the flash cache whatever the layout of the image. The unrolled nerdSHA256plus (20 KB) did 8.2k
// cycles a hash in one build and 44k in the next, when other code happened to share its cache lines; this one does ~10k always.
// A hit is word 7 under the engine's mask for the pool difficulty, so its shares count like the engine's.
typedef struct { uint32_t w[19], mid[8]; sha256d_pre_t pre; } swjob_t;
static void sw_prep(swjob_t *j) {
    memcpy(j->mid, SHA256_IV, 32); sha256_compress(j->mid, j->w); sha256d_prep(&j->pre, j->mid, j->w + 16);
}
static inline uint32_t sw_h7(swjob_t *j, uint32_t nonce_word) { return sha256d_h7(&j->pre, nonce_word); }
static void swtask(void *arg) {
    static job_t job; static session_t sess; static swjob_t sj; uint32_t seq = 0;
    uint32_t en2 = 0, nonce = 0; bool have = false; int64_t win_t = esp_timer_get_time(); uint64_t win_h = 0;
    for (;;) {
        if (stratum_get_job(&job, &sess, &seq)) {
            en2 = 0x80000000u | ((uint32_t)(esp_timer_get_time() & 0xffff) << 8); nonce = 0;
            job_build_words(&job, &sess, en2, sj.w); sw_prep(&sj); have = true;
        }
        if (!have || !g_stratum.connected || !g_sw_enabled) { have = have && g_stratum.connected; if (!g_sw_enabled) g_miner.sw_hashrate = 0; vTaskDelay(pdMS_TO_TICKS(100)); continue; }
        uint32_t mask = hit_mask_for(g_stratum.pool_diff);
        for (int k = 0; k < 2048; k++, nonce++) {
            if (!(sw_h7(&sj, nonce) & mask)) { candidate_t c = { .job_seq = seq, .en2 = en2, .nonce_word = nonce }; memcpy(c.w, sj.w, sizeof sj.w); stratum_submit_candidate(&c); }
            if (nonce == 0xFFFFFFFFu) { en2++; nonce = 0; job_build_words(&job, &sess, en2, sj.w); sw_prep(&sj); break; }
        }
        win_h += 2048; g_miner.sw_hashes += 2048;
        int64_t now = esp_timer_get_time();
        if (now - win_t >= 5000000) { g_miner.sw_hashrate = (double)win_h * 1e6 / (now - win_t); win_t = now; win_h = 0; }
        taskYIELD();
    }
}
// cycles per software hash on the calling core (core 1 when called from httpd); *ok: the digest word matches job_hash
uint32_t sw_bench_cycles(int *ok) {
    static swjob_t j; for (int i = 0; i < 19; i++) j.w[i] = ((uint32_t)genesis[4*i] << 24) | ((uint32_t)genesis[4*i+1] << 16) | ((uint32_t)genesis[4*i+2] << 8) | genesis[4*i+3];
    sw_prep(&j); volatile uint32_t sink = 0;
    uint32_t c0 = esp_cpu_get_cycle_count();
    for (uint32_t n = 0; n < 4096; n++) sink ^= sw_h7(&j, n);
    uint32_t c = (esp_cpu_get_cycle_count() - c0) / 4096;
    uint32_t H[8]; job_hash(j.w, 0x1dac2b7cu, H); *ok = sw_h7(&j, 0x1dac2b7cu) == H[7] && H[7] == 0;   // the genesis nonce: word 7 is zero
    return c;
}
void miner_start(void) {
    if (xTaskCreatePinnedToCore(task, "miner", 8192, NULL, 10, NULL, 0) != pdPASS) ESP_LOGE(TAG, "miner task not created (internal RAM %u free)", (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    if (xTaskCreatePinnedToCore(swtask, "swminer", 8192, NULL, 1, NULL, 1) != pdPASS) ESP_LOGE(TAG, "software miner task not created");
    ESP_LOGI(TAG, "tasks started, internal RAM %u free", (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
}
