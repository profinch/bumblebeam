#include "nvs_flash.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "config.h"
#include "wifi.h"
#include "stratum.h"
#include "miner.h"
#include "web.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
static const char *TAG = "main";
void app_main(void) {
    esp_err_t e = nvs_flash_init(); if (e == ESP_ERR_NVS_NO_FREE_PAGES || e == ESP_ERR_NVS_NEW_VERSION_FOUND) { nvs_flash_erase(); nvs_flash_init(); }
    config_load();
    ESP_LOGI(TAG, "ESP32 open miner: pool %s:%u wallet %s", g_cfg.pool, g_cfg.port, g_cfg.wallet);
    wifi_start(); stratum_start(); web_start(); miner_start();
    const esp_partition_t *run = esp_ota_get_running_partition(); ESP_LOGI(TAG, "running from %s", run ? run->label : "?");
    esp_ota_mark_app_valid_cancel_rollback();
    for (;;) { vTaskDelay(pdMS_TO_TICKS(30000)); ESP_LOGI(TAG, "hashrate %.1f KH/s (engine) + %.1f KH/s (sw core1), shares %u/%u, best %.4g, jobs %u, kernel %u cyc/nonce, heap %u", g_miner.hashrate / 1e3, g_miner.sw_hashrate / 1e3, (unsigned)g_stratum.accepted, (unsigned)g_stratum.rejected, g_stratum.best_session, (unsigned)g_stratum.jobs, (unsigned)g_miner.kernel_cycles, (unsigned)esp_get_free_heap_size()); }
}
