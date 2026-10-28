#include "history.h"
#include "miner.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include <stdlib.h>
static uint16_t *s_h; static volatile uint32_t s_n, s_pos; static uint64_t s_last;
static void sample(void *arg) {
    uint64_t t = g_miner.total_hashes + g_miner.sw_hashes, d = t - s_last; s_last = t;
    uint32_t khs = (uint32_t)(d / 60000); if (khs > 65535) khs = 65535;
    s_h[s_pos] = khs; s_pos = (s_pos + 1) % HISTORY_MINUTES; if (s_n < HISTORY_MINUTES) s_n++;
}
void history_start(void) {
    s_h = heap_caps_calloc(HISTORY_MINUTES, sizeof *s_h, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);   // PSRAM boards keep internal RAM free
    if (!s_h) s_h = calloc(HISTORY_MINUTES, sizeof *s_h);
    if (!s_h) return;
    s_last = g_miner.total_hashes + g_miner.sw_hashes;
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
