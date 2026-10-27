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
#include "nerdsha.h"
static const char *TAG = "miner";
miner_stats_t g_miner;
extern uint32_t hwmine(uint32_t *tbl, uint32_t nonce_start, uint32_t count, uint32_t E, uint32_t d2);
#define ENGINE_E 68
#define LOAD_D2  8
#define CHUNK    16384
static uint32_t DRAM_ATTR s_tbl[32];
static uint32_t hit_mask_for(double pool_diff) {
    // a share needs >= 32 + floor(log2(diff)) leading zero bits of the hash number, whose top 32 bits are bswap(word7)
    int bits = 32 + (int)floor(log2(pool_diff > 0 ? pool_diff : 1e-9));
    if (bits >= 32) return 0xFFFFFFFFu;
    if (bits <= 8) return 0x000000FFu;
    return __builtin_bswap32(~(0xFFFFFFFFu >> bits));
}
static const uint8_t genesis[80] = {
    0x01,0x00,0x00,0x00, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
    0x3b,0xa3,0xed,0xfd,0x7a,0x7b,0x12,0xb2,0x7a,0xc7,0x2c,0x3e,0x67,0x76,0x8f,0x61,0x7f,0xc8,0x1b,0xc3,0x88,0x8a,0x51,0x32,0x3a,0x9f,0xb8,0xaa,0x4b,0x1e,0x5e,0x4a,
    0x29,0xab,0x5f,0x49, 0xff,0xff,0x00,0x1d, 0x1d,0xac,0x2b,0x7c };
static bool selftest(void) {
    for (int i = 0; i < 19; i++) s_tbl[i] = ((uint32_t)genesis[4*i] << 24) | ((uint32_t)genesis[4*i+1] << 16) | ((uint32_t)genesis[4*i+2] << 8) | genesis[4*i+3];
    s_tbl[23] = 0xFFFFFFFFu; const uint32_t tgt = 0x1dac2b7cu; uint32_t hits = 0, hitn = 0, cyc = 0, total = 0;
    for (uint32_t n0 = tgt - 100000; n0 < tgt + 100000; n0 += 20000) {
        uint32_t n = n0, endn = n0 + 20000;
        while (n < endn) { s_tbl[24] = 0; portDISABLE_INTERRUPTS(); uint32_t c0 = esp_cpu_get_cycle_count(); uint32_t r = hwmine(s_tbl, n, endn - n, ENGINE_E, LOAD_D2); cyc += esp_cpu_get_cycle_count() - c0; portENABLE_INTERRUPTS(); if (s_tbl[24]) { hits++; hitn = r; n = r + 1; } else n = endn; }
        total += 20000; vTaskDelay(1);
    }
    bool ok = (hits == 1 && hitn == tgt);
    // single-nonce digest check: after hwmine returns, TEXT[0..7] holds H2 of the last nonce processed
    { uint32_t w[19]; for (int i = 0; i < 19; i++) w[i] = s_tbl[i]; uint32_t H[8]; job_hash(w, tgt, H);
      s_tbl[24] = 0; portDISABLE_INTERRUPTS(); uint32_t r = hwmine(s_tbl, tgt, 1, ENGINE_E, LOAD_D2); portENABLE_INTERRUPTS();
      volatile uint32_t *T = (volatile uint32_t *)0x3ff03000; uint32_t E[8]; for (int i = 0; i < 8; i++) E[i] = T[i];
      ESP_LOGI(TAG, "single nonce: ret %08x hit %u | engine %08x %08x .. %08x | sw %08x %08x .. %08x", (unsigned)r, (unsigned)s_tbl[24], (unsigned)E[0], (unsigned)E[1], (unsigned)E[7], (unsigned)H[0], (unsigned)H[1], (unsigned)H[7]); }
    ESP_LOGI(TAG, "SELFTEST %s: %.1f cycles/nonce = %.1f KH/s (hits %u, nonce %08x)", ok ? "OK" : "WRONG", (double)cyc / total, 240000.0 * total / cyc, (unsigned)hits, (unsigned)hitn);
    return ok;
}
static void task(void *arg) {
    periph_module_enable(PERIPH_SHA_MODULE);
    s_tbl[19] = 0x80000000u; s_tbl[20] = 640; s_tbl[21] = 256; s_tbl[22] = 1; s_tbl[23] = 0xFFFFFFFFu;
    selftest();
    static job_t job; static session_t sess; uint32_t seq = 0; static uint32_t w[19]; uint32_t en2 = 0, nonce = 0; bool have = false;
    int64_t win_t = esp_timer_get_time(); uint64_t win_h = 0; g_miner.start_us = win_t;
    s_tbl[19] = 0x80000000u; s_tbl[20] = 640; s_tbl[21] = 256; s_tbl[22] = 1; s_tbl[23] = 0xFFFFFFFFu;
    for (;;) {
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
        uint32_t r = hwmine(s_tbl, nonce, count, ENGINE_E, LOAD_D2);
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
// core 1: software SHA256d (nerdSHA256plus) in idle time, own extranonce2 range
static void swtask(void *arg) {
    static job_t job; static session_t sess; uint32_t seq = 0; static uint32_t w[19]; static uint8_t hdr[80]; static uint32_t mid[8], bake[16];
    uint32_t en2 = 0, nonce = 0; bool have = false; int64_t win_t = esp_timer_get_time(); uint64_t win_h = 0;
    for (;;) {
        if (stratum_get_job(&job, &sess, &seq)) {
            en2 = 0x80000000u | ((uint32_t)(esp_timer_get_time() & 0xffff) << 8); nonce = 0;
            job_build_words(&job, &sess, en2, w);
            for (int i = 0; i < 19; i++) { hdr[4*i] = w[i] >> 24; hdr[4*i+1] = w[i] >> 16; hdr[4*i+2] = w[i] >> 8; hdr[4*i+3] = w[i]; }
            nerd_mids(mid, hdr); nerd_sha256_bake(mid, hdr + 64, bake); have = true;
        }
        if (!have || !g_stratum.connected) { have = have && g_stratum.connected; vTaskDelay(pdMS_TO_TICKS(100)); continue; }
        for (int k = 0; k < 2048; k++, nonce++) {
            hdr[76] = nonce >> 24; hdr[77] = nonce >> 16; hdr[78] = nonce >> 8; hdr[79] = nonce;
            uint8_t dh[32];
            if (nerd_sha256d_baked(mid, hdr + 64, bake, dh)) { candidate_t c = { .job_seq = seq, .en2 = en2, .nonce_word = nonce }; memcpy(c.w, w, sizeof w); stratum_submit_candidate(&c); }
            if (nonce == 0xFFFFFFFFu) { en2++; nonce = 0; job_build_words(&job, &sess, en2, w); for (int i = 0; i < 19; i++) { hdr[4*i] = w[i] >> 24; hdr[4*i+1] = w[i] >> 16; hdr[4*i+2] = w[i] >> 8; hdr[4*i+3] = w[i]; } nerd_mids(mid, hdr); nerd_sha256_bake(mid, hdr + 64, bake); break; }
        }
        win_h += 2048; g_miner.sw_hashes += 2048;
        int64_t now = esp_timer_get_time();
        if (now - win_t >= 5000000) { g_miner.sw_hashrate = (double)win_h * 1e6 / (now - win_t); win_t = now; win_h = 0; }
        taskYIELD();
    }
}
void miner_start(void) { xTaskCreatePinnedToCore(task, "miner", 16384, NULL, 10, NULL, 0); xTaskCreatePinnedToCore(swtask, "swminer", 12288, NULL, 1, NULL, 1); }
