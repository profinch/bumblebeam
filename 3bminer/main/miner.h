#pragma once
#include <stdint.h>
typedef struct { volatile double hashrate; volatile uint64_t total_hashes; volatile uint32_t candidates; volatile int64_t start_us; volatile uint32_t kernel_cycles; volatile double sw_hashrate; volatile uint64_t sw_hashes; } miner_stats_t;
extern miner_stats_t g_miner;
void miner_start(void);
