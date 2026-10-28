#include "config.h"
#if __has_include("secrets.h")
#include "secrets.h"            // local Wi-Fi and payout defaults, not in git
#else
#include "secrets.example.h"
#endif
#include "nvs_flash.h"
#include "nvs.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include "sdkconfig.h"
miner_cfg_t g_cfg;
static void gets_(nvs_handle_t h, const char *k, char *dst, size_t n, const char *def) { size_t l = n; if (nvs_get_str(h, k, dst, &l) != ESP_OK) { strncpy(dst, def, n - 1); dst[n-1] = 0; } }
void config_load(void) {
    nvs_handle_t h; memset(&g_cfg, 0, sizeof g_cfg);
    bool ok = nvs_open("miner", NVS_READONLY, &h) == ESP_OK;
    gets_(ok ? h : 0, "ssid", g_cfg.ssid, sizeof g_cfg.ssid, DEF_SSID);
    gets_(ok ? h : 0, "pass", g_cfg.pass, sizeof g_cfg.pass, DEF_PASS);
    gets_(ok ? h : 0, "bssid", g_cfg.bssid, sizeof g_cfg.bssid, DEF_BSSID);
    gets_(ok ? h : 0, "pool", g_cfg.pool, sizeof g_cfg.pool, DEF_POOL);
    gets_(ok ? h : 0, "wallet", g_cfg.wallet, sizeof g_cfg.wallet, DEF_WALLET);
    gets_(ok ? h : 0, "worker", g_cfg.worker, sizeof g_cfg.worker, CONFIG_BOARD_DEFAULT_WORKER);
    uint16_t p = DEF_PORT; if (ok) nvs_get_u16(h, "port", &p); g_cfg.port = p;
    char sd[16]; gets_(ok ? h : 0, "suggest", sd, sizeof sd, "x"); g_cfg.suggest = (sd[0] == 'x') ? DEF_SUGGEST : atof(sd);
#ifdef CONFIG_BOARD_MINING_DEFAULT
    uint8_t mine = 1;
#else
    uint8_t mine = 0;
#endif
    if (ok) nvs_get_u8(h, "mine", &mine);
    g_cfg.mining = mine;
    if (ok) nvs_close(h);
}
bool config_save(void) {
    nvs_handle_t h; if (nvs_open("miner", NVS_READWRITE, &h) != ESP_OK) return false;
    nvs_set_str(h, "ssid", g_cfg.ssid); nvs_set_str(h, "pass", g_cfg.pass); nvs_set_str(h, "bssid", g_cfg.bssid);
    nvs_set_str(h, "pool", g_cfg.pool); nvs_set_u16(h, "port", g_cfg.port); nvs_set_str(h, "wallet", g_cfg.wallet); nvs_set_str(h, "worker", g_cfg.worker);
    char sd[16]; snprintf(sd, sizeof sd, "%g", g_cfg.suggest); nvs_set_str(h, "suggest", sd); nvs_set_u8(h, "mine", g_cfg.mining);
    bool ok = nvs_commit(h) == ESP_OK; nvs_close(h); return ok;
}
