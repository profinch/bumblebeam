#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "job.h"
typedef struct { uint32_t job_seq; uint32_t en2; uint32_t nonce_word; uint32_t w[19]; } candidate_t;
typedef struct {
    volatile bool connected; volatile double pool_diff; volatile uint32_t accepted, rejected, submitted;
    volatile double best_session, best_ever, last_share_diff, net_diff; volatile uint32_t jobs; volatile int64_t last_job_us;
    char pool_desc[96]; char user[128];
    volatile int8_t solo;           // 1 = the coinbase pays the configured address (solo pool), 0 = it does not, -1 = no job yet
    volatile uint32_t cand_dropped, stale_dropped, old_job_submits, rej_stale, rej_dup, rej_lowdiff, rej_other; char last_reject[96];
} stratum_stats_t;
extern stratum_stats_t g_stratum;
void stratum_start(void);
// miner side
bool stratum_get_job(job_t *dst, session_t *s, uint32_t *seq);   // copies the current job if seq differs; returns true if copied
void stratum_submit_candidate(const candidate_t *c);
