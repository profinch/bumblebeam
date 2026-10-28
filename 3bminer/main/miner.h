#pragma once
#include <stdint.h>
typedef struct { volatile double hashrate; volatile uint64_t total_hashes; volatile uint32_t candidates; volatile int64_t start_us; volatile uint32_t kernel_cycles; volatile double sw_hashrate; volatile uint64_t sw_hashes; } miner_stats_t;
extern miner_stats_t g_miner;
void miner_start(void);
// on-device timing bench: per-stage kernel waits t[0..4] = tbl[25..29]; run on core 0 over n nonces of a fixed header
typedef struct { volatile int req, done; uint32_t t[5], n, k; uint32_t cyc_per_kn, hits, bad, sum; int apply; } bench_t;
extern bench_t g_bench;
extern volatile uint32_t g_timing[5];
extern volatile uint32_t g_kernel;
extern volatile uint32_t g_sw_enabled;   // core-1 software hasher on/off
uint32_t sw_bench_cycles(int *ok);
#include <stdbool.h>
bool miner_kernel_ok(uint32_t k);   // 0 = hwmine, 3 = hwmine_k6 (the default)
