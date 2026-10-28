#include "nvs_flash.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "config.h"
#include "wifi.h"
#include "stratum.h"
#include "miner.h"
#include "web.h"
#include "camera.h"
#include "version.h"
#include "history.h"
#include <stdlib.h>
#include <time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
static const char *TAG = "main";
void app_main(void) {
    esp_err_t e = nvs_flash_init(); if (e == ESP_ERR_NVS_NO_FREE_PAGES || e == ESP_ERR_NVS_NEW_VERSION_FOUND) { nvs_flash_erase(); nvs_flash_init(); }
    config_load();
    setenv("TZ", g_cfg.tz[0] ? g_cfg.tz : "UTC0", 1); tzset();   // the board's clock (NTP) in the chosen time zone
    ESP_LOGI(TAG, "3BMiner %s on %s: pool %s:%u wallet %s", FW_VERSION, CONFIG_BOARD_ID, g_cfg.pool, g_cfg.port, g_cfg.wallet);
    wifi_start(); web_start();
#ifdef CONFIG_BOARD_HAS_CAMERA
    camera_start();   // core 1 (main task affinity): its grab task and ISR stay off the mining core
#endif
    if (g_cfg.mining) { stratum_start(); miner_start(); history_start(); } else ESP_LOGW(TAG, "mining is off (settings: mining=true to start)");
    const esp_partition_t *run = esp_ota_get_running_partition(); ESP_LOGI(TAG, "running from %s", run ? run->label : "?");
    esp_ota_mark_app_valid_cancel_rollback();
    for (;;) { vTaskDelay(pdMS_TO_TICKS(30000)); ESP_LOGI(TAG, "hashrate %.1f KH/s (engine) + %.1f KH/s (sw core1), shares %u/%u, best %.4g, jobs %u, kernel %u cyc/nonce, heap %u", g_miner.hashrate / 1e3, g_miner.sw_hashrate / 1e3, (unsigned)g_stratum.accepted, (unsigned)g_stratum.rejected, g_stratum.best_session, (unsigned)g_stratum.jobs, (unsigned)g_miner.kernel_cycles, (unsigned)esp_get_free_heap_size()); }
}
