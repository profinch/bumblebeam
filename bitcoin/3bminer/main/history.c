#include "history.h"
#include "miner.h"
#include "stratum.h"
#include <string.h>
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include <stdlib.h>
#include "nvs.h"
static uint16_t *s_h; static volatile uint32_t s_n, s_pos; static uint64_t s_last;
static volatile bool s_save; static double s_best_saved; static uint64_t s_base_h, s_start_h; static uint32_t s_base_s; static int64_t s_start_us; static uint32_t s_minutes;
static void sample(void *arg) {
    uint64_t t = g_miner.total_hashes + g_miner.sw_hashes, d = t - s_last; s_last = t;
    uint32_t khs = (uint32_t)(d / 60000); if (khs > 65535) khs = 65535;
    s_h[s_pos] = khs; s_pos = (s_pos + 1) % HISTORY_MINUTES; if (s_n < HISTORY_MINUTES) s_n++;
    if (++s_minutes % 10 == 0) s_save = true;   // all-time totals to NVS every 10 minutes (~144 small writes a day, far below flash wear limits)
}
// from the main task, not the esp_timer callback: a flash write stalls both cores for milliseconds, which the timer task must not carry
// the best share ever is kept too (as the double's bits), written within 30 s of a new best: it survives restarts and
// firmware updates (OTA leaves NVS alone), not an NVS erase
void history_save(void) {
    double best = g_stratum.best_ever; bool nb = best > s_best_saved;
    if (!s_save && !nb) return;
    nvs_handle_t h; if (nvs_open("stats", NVS_READWRITE, &h) != ESP_OK) return;
    if (s_save) { s_save = false; nvs_set_u64(h, "hashes", s_base_h + (g_miner.total_hashes + g_miner.sw_hashes - s_start_h)); nvs_set_u32(h, "secs", history_all_seconds()); }
    if (nb) { uint64_t b; memcpy(&b, &best, sizeof b); nvs_set_u64(h, "best", b); s_best_saved = best; }
    nvs_commit(h); nvs_close(h);
}
void history_start(void) {
    s_h = heap_caps_calloc(HISTORY_MINUTES, sizeof *s_h, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);   // PSRAM boards keep internal RAM free
    if (!s_h) s_h = calloc(HISTORY_MINUTES, sizeof *s_h);
    if (!s_h) return;
    s_last = s_start_h = g_miner.total_hashes + g_miner.sw_hashes; s_start_us = esp_timer_get_time();
    nvs_handle_t h; if (nvs_open("stats", NVS_READONLY, &h) == ESP_OK) { nvs_get_u64(h, "hashes", &s_base_h); nvs_get_u32(h, "secs", &s_base_s);
        uint64_t b; if (nvs_get_u64(h, "best", &b) == ESP_OK) { memcpy(&s_best_saved, &b, sizeof b); if (s_best_saved > g_stratum.best_ever) g_stratum.best_ever = s_best_saved; }
        nvs_close(h); }
    const esp_timer_create_args_t a = { .callback = sample, .name = "history" }; esp_timer_handle_t t;
    if (esp_timer_create(&a, &t) == ESP_OK) esp_timer_start_periodic(t, 60ULL * 1000000);
}
uint32_t history_count(void) { return s_h ? s_n : 0; }
uint16_t history_get(uint32_t i) { uint32_t n = s_n; return s_h && i < n ? s_h[(s_pos + HISTORY_MINUTES - n + i) % HISTORY_MINUTES] : 0; }
double history_avg_khs(uint32_t minutes) {
    uint32_t n = history_count(); if (!n) return -1; if (minutes > n) minutes = n;
    uint64_t sum = 0; for (uint32_t i = n - minutes; i < n; i++) sum += history_get(i);
    return (double)sum / minutes;
}
uint32_t history_all_seconds(void) { return s_start_us ? s_base_s + (uint32_t)((esp_timer_get_time() - s_start_us) / 1000000) : 0; }
double history_avg_all_khs(void) {
    uint32_t sec = history_all_seconds(); if (!sec) return -1;
    return (double)(s_base_h + (g_miner.total_hashes + g_miner.sw_hashes - s_start_h)) / sec / 1000.0;
}
