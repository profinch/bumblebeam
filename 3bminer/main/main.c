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
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "esp_attr.h"
#include "lwip/sockets.h"
#include "swarm.h"
#include "web.h"
#include <string.h>
static const char *TAG = "main";
// Why the firmware restarted itself, kept in RTC memory across that restart (not across power): shown in /api/system/info
static RTC_NOINIT_ATTR char s_why[32]; static RTC_NOINIT_ATTR uint32_t s_why_magic;
static char s_last_why[32];
const char *main_restart_why(void) { return s_last_why; }
static void restart_because(const char *why) { ESP_LOGE(TAG, "restarting: %s", why); strncpy(s_why, why, sizeof s_why - 1); s_why[sizeof s_why - 1] = 0; s_why_magic = 0x3B3B3B3B; vTaskDelay(pdMS_TO_TICKS(200)); esp_restart(); }
// the web server answers its own /alive over loopback within 3 s (an OTA or an engine check holds it longer, hence 5 misses in a row)
static bool web_alive(void) {
    int s = socket(AF_INET, SOCK_STREAM, 0); if (s < 0) return false;
    struct timeval tv = { .tv_sec = 3 }; setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv); setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(80), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    bool ok = false; char b[16];
    if (connect(s, (struct sockaddr *)&a, sizeof a) == 0) { const char q[] = "GET /probe HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"; ok = send(s, q, sizeof q - 1, 0) == sizeof q - 1 && recv(s, b, sizeof b, 0) > 0; }
    close(s); return ok;
}
void app_main(void) {
    if (s_why_magic == 0x3B3B3B3B) { memcpy(s_last_why, s_why, sizeof s_last_why); s_last_why[sizeof s_last_why - 1] = 0; ESP_LOGW(TAG, "restarted itself: %s", s_last_why); } s_why_magic = 0;
    esp_err_t e = nvs_flash_init(); if (e == ESP_ERR_NVS_NO_FREE_PAGES || e == ESP_ERR_NVS_NEW_VERSION_FOUND) { nvs_flash_erase(); nvs_flash_init(); }
    config_load();
    setenv("TZ", g_cfg.tz[0] ? g_cfg.tz : "UTC0", 1); tzset();   // the board's clock (NTP) in the chosen time zone
    ESP_LOGI(TAG, "3BMiner %s on %s: pool %s:%u wallet %s", FW_VERSION, CONFIG_BOARD_ID, g_cfg.pool, g_cfg.port, g_cfg.wallet);
    wifi_start(); web_start();
#ifdef CONFIG_BOARD_HAS_CAMERA
    camera_start();   // core 1 (main task affinity): its grab task and ISR stay off the mining core
#endif
    if (g_cfg.mining) { stratum_start(); miner_start(); history_start(); } else ESP_LOGW(TAG, "mining is off (settings: mining=true to start)");
    swarm_start();
    const esp_partition_t *run = esp_ota_get_running_partition(); ESP_LOGI(TAG, "running from %s", run ? run->label : "?");
    // health, every 30 s: this loop itself under the task watchdog (2 min), Wi-Fi back within 5 min, the web server answering.
    // A board that loses one of them restarts and says why, instead of mining on unreachable until someone pulls the plug.
    esp_task_wdt_add(NULL); int64_t wifi_ok = esp_timer_get_time(); int web_miss = 0;
    for (;;) { vTaskDelay(pdMS_TO_TICKS(30000)); esp_task_wdt_reset(); history_save();
        int64_t now = esp_timer_get_time();
        if (wifi_connected()) wifi_ok = now; else if (now - wifi_ok > 300LL * 1000000) restart_because("wifi down 5 min");
        if (wifi_connected() && !g_ota_busy && !g_web_long) { if (web_alive()) web_miss = 0; else if (++web_miss >= 5) restart_because("web server not answering"); }
        else web_miss = 0;   // a long request holds the server: no verdict
        ESP_LOGI(TAG, "hashrate %.1f KH/s (engine) + %.1f KH/s (sw core1), shares %u/%u, best %.4g, jobs %u, kernel %u cyc/nonce, heap %u", g_miner.hashrate / 1e3, g_miner.sw_hashrate / 1e3, (unsigned)g_stratum.accepted, (unsigned)g_stratum.rejected, g_stratum.best_session, (unsigned)g_stratum.jobs, (unsigned)g_miner.kernel_cycles, (unsigned)esp_get_free_heap_size()); }
}
