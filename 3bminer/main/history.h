#pragma once
#include <stdint.h>
// hashrate history on the board: one sample a minute (engine + software, KH/s) for the last 24 h, kept in RAM
#define HISTORY_MINUTES 1440
void history_start(void);
uint32_t history_count(void);            // samples so far, up to HISTORY_MINUTES
uint16_t history_get(uint32_t i);        // i = 0 is the oldest
double history_avg_khs(uint32_t minutes); // average of the last `minutes` samples (fewer if the board runs shorter); < 0 if none yet
