#include "config.h"
// No Wi-Fi or payout defaults are compiled in (an image stays free of anybody's password): a new board comes up as its
// own access point (wifi.c) and is set up from its page
#define DEF_POOL     "solobtc.nmminer.com"
#define DEF_PORT     3333
#define DEF_SUGGEST  0.001
#include "nvs_flash.h"
#include "nvs.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include "sdkconfig.h"
miner_cfg_t g_cfg;
#define CFG_VER 1
typedef struct { uint8_t ver; miner_cfg_t c; } cfg_blob_t;
static void gets_(nvs_handle_t h, const char *k, char *dst, size_t n, const char *def) { size_t l = n; if (nvs_get_str(h, k, dst, &l) != ESP_OK) { strncpy(dst, def, n - 1); dst[n-1] = 0; } }
void config_load(void) {
    nvs_handle_t h; memset(&g_cfg, 0, sizeof g_cfg);
    bool ok = nvs_open("miner", NVS_READONLY, &h) == ESP_OK;
    cfg_blob_t b; size_t bl = sizeof b;
    if (ok && nvs_get_blob(h, "cfg", &b, &bl) == ESP_OK && bl == sizeof b && b.ver == CFG_VER) { g_cfg = b.c; g_cfg.ssid[sizeof g_cfg.ssid - 1] = 0; nvs_close(h); return; }
    // before 1.0: one key per setting
    gets_(ok ? h : 0, "ssid", g_cfg.ssid, sizeof g_cfg.ssid, "");
    gets_(ok ? h : 0, "pass", g_cfg.pass, sizeof g_cfg.pass, "");
    gets_(ok ? h : 0, "bssid", g_cfg.bssid, sizeof g_cfg.bssid, "");
    gets_(ok ? h : 0, "pool", g_cfg.pool, sizeof g_cfg.pool, DEF_POOL);
    gets_(ok ? h : 0, "wallet", g_cfg.wallet, sizeof g_cfg.wallet, "");
    gets_(ok ? h : 0, "worker", g_cfg.worker, sizeof g_cfg.worker, CONFIG_BOARD_DEFAULT_WORKER);
    gets_(ok ? h : 0, "tz", g_cfg.tz, sizeof g_cfg.tz, "UTC0");
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
// the settings as one blob: NVS writes a blob as a single entry, so a power cut or a full NVS leaves either the old settings
// or the new ones, never half of each (separate keys are each written at once; nvs_commit cannot undo them)
bool config_save(void) {
    nvs_handle_t h; if (nvs_open("miner", NVS_READWRITE, &h) != ESP_OK) return false;
    cfg_blob_t b = { .ver = CFG_VER, .c = g_cfg };
    esp_err_t e = nvs_set_blob(h, "cfg", &b, sizeof b); if (!e) e = nvs_commit(h);
    nvs_close(h); return e == ESP_OK;
}
