#include "wifi.h"
#include "config.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_log.h"
#include "esp_mac.h"
#include <string.h>
#include <stdio.h>
#include "sdkconfig.h"
#include "esp_netif_sntp.h"
#include <sys/time.h>
static const char *TAG = "wifi";
volatile int64_t g_ntp_sync = 0;   // Unix time of the last NTP sync, 0 = never
const char *const g_ntp_server = "pool.ntp.org";
static void ntp_synced(struct timeval *tv) { g_ntp_sync = tv->tv_sec; ESP_LOGI(TAG, "clock set from %s", g_ntp_server); }
static volatile bool s_conn = false; static char s_ip[16] = "0.0.0.0";
static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) esp_wifi_connect();
    else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) { s_conn = false; ESP_LOGW(TAG, "disconnected, retry"); vTaskDelay(pdMS_TO_TICKS(1000)); esp_wifi_connect(); }
    else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) { ip_event_got_ip_t *e = data; snprintf(s_ip, sizeof s_ip, IPSTR, IP2STR(&e->ip_info.ip)); s_conn = true; ESP_LOGI(TAG, "got ip %s", s_ip);
        static bool sntp = false; if (!sntp) { esp_sntp_config_t c = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org"); c.sync_cb = ntp_synced; esp_netif_sntp_init(&c); sntp = true; } }   // the board's clock (UTC)
}
void wifi_start(void) {
    esp_netif_init(); esp_event_loop_create_default();
    esp_netif_t *n = esp_netif_create_default_wifi_sta(); char host[32]; uint8_t mac[6]; esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(host, sizeof host, CONFIG_BOARD_HOST_PREFIX "-%02x%02x%02x", mac[3], mac[4], mac[5]); esp_netif_set_hostname(n, host);
    wifi_init_config_t ic = WIFI_INIT_CONFIG_DEFAULT(); esp_wifi_init(&ic);
    esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL);
    esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL);
    wifi_config_t wc = {0}; strncpy((char *)wc.sta.ssid, g_cfg.ssid, 32); strncpy((char *)wc.sta.password, g_cfg.pass, 64);
    unsigned b[6]; if (sscanf(g_cfg.bssid, "%x:%x:%x:%x:%x:%x", &b[0], &b[1], &b[2], &b[3], &b[4], &b[5]) == 6) { for (int i = 0; i < 6; i++) wc.sta.bssid[i] = b[i]; wc.sta.bssid_set = 1; }
    wc.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK; wc.sta.pmf_cfg.capable = true;
    esp_wifi_set_mode(WIFI_MODE_STA); esp_wifi_set_config(WIFI_IF_STA, &wc); esp_wifi_set_ps(WIFI_PS_NONE); esp_wifi_start();
}
bool wifi_connected(void) { return s_conn; }
int wifi_rssi(void) { wifi_ap_record_t r; return esp_wifi_sta_get_ap_info(&r) == ESP_OK ? r.rssi : 0; }
const char *wifi_ip(void) { return s_ip; }
