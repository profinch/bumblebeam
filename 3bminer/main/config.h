#pragma once
#include <stdint.h>
#include <stdbool.h>
typedef struct {
    char ssid[33], pass[65], bssid[18];
    char pool[64]; uint16_t port;
    char wallet[96], worker[32];
    double suggest;
} miner_cfg_t;
extern miner_cfg_t g_cfg;
void config_load(void);
bool config_save(void);
