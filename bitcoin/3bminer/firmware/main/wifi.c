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
#include "esp_timer.h"
static const char *TAG = "wifi";
volatile int64_t g_ntp_sync = 0;   // Unix time of the last NTP sync, 0 = never
// two time servers: the second answers when the first does not; g_ntp_server is the one that set the clock last
static const char *const NTP[2] = { "pool.ntp.org", "time.google.com" };
const char *volatile g_ntp_server = "pool.ntp.org";
static void ntp_synced(struct timeval *tv) {
    g_ntp_sync = tv->tv_sec;
    for (int i = 0; i < 2; i++) { unsigned r = 0; if (esp_netif_sntp_reachability(i, &r) == ESP_OK && (r & 1)) { g_ntp_server = NTP[i]; break; } }   // bit 0: the last poll was answered
    ESP_LOGI(TAG, "clock set from %s", g_ntp_server);
}
static volatile bool s_conn = false; static char s_ip[16] = "0.0.0.0";
// Set-up access point: a board with no Wi-Fi saved, or one that has not reached its network for 2 minutes, also opens its own
// network (3BMiner-xxxxxx, open: it exists only while the board is being set up, within Wi-Fi reach) with the page at
// http://192.168.4.1/, while it keeps trying its own. Once it is back on its network and nobody is connected to the set-up
// one, that closes again
#define AP_AFTER_US (120LL * 1000000)
static volatile bool s_ap = false; static int64_t s_down_since; static char s_host[32];
static void ap_set(bool on) {
    if (on == s_ap) return;
    if (on) { wifi_config_t ac = { .ap = { .max_connection = 2, .authmode = WIFI_AUTH_OPEN, .channel = 1 } };
        int l = snprintf((char *)ac.ap.ssid, sizeof ac.ap.ssid, "%s", s_host); ac.ap.ssid_len = l;
        esp_wifi_set_mode(WIFI_MODE_APSTA); esp_wifi_set_config(WIFI_IF_AP, &ac); ESP_LOGW(TAG, "set-up network %s open: http://192.168.4.1/", s_host); }
    else { esp_wifi_set_mode(WIFI_MODE_STA); ESP_LOGI(TAG, "set-up network closed"); }
    s_ap = on;
}
static void ap_check(void *arg) {
    int64_t now = esp_timer_get_time();
    static int tick; tick++;
    if (!s_conn) { if (!s_ap && (!g_cfg.ssid[0] || now - s_down_since > AP_AFTER_US)) ap_set(true); else if (s_ap && g_cfg.ssid[0] && tick % 3 == 0) esp_wifi_connect(); }
    else if (s_ap) { wifi_sta_list_t l; if (esp_wifi_ap_get_sta_list(&l) != ESP_OK || l.num == 0) ap_set(false); }
}
bool wifi_ap_active(void) { return s_ap; }
static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) { if (g_cfg.ssid[0]) esp_wifi_connect(); }
    else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) { if (s_conn) s_down_since = esp_timer_get_time(); s_conn = false; ESP_LOGW(TAG, "disconnected, retry"); if (g_cfg.ssid[0] && !s_ap) esp_wifi_connect(); }   // with the set-up network open, ap_check retries (a scan takes the radio off its channel)
    else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) { ip_event_got_ip_t *e = data; snprintf(s_ip, sizeof s_ip, IPSTR, IP2STR(&e->ip_info.ip)); s_conn = true; ESP_LOGI(TAG, "got ip %s", s_ip);
        static bool sntp = false; if (!sntp) { esp_sntp_config_t c = ESP_NETIF_SNTP_DEFAULT_CONFIG_MULTIPLE(2, ESP_SNTP_SERVER_LIST(NTP[0], NTP[1])); c.sync_cb = ntp_synced; esp_netif_sntp_init(&c); sntp = true; } }   // the board's clock (UTC)
}
void wifi_start(void) {
    esp_netif_init(); esp_event_loop_create_default();
    esp_netif_t *n = esp_netif_create_default_wifi_sta(); esp_netif_create_default_wifi_ap(); uint8_t mac[6]; esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(s_host, sizeof s_host, CONFIG_BOARD_HOST_PREFIX "-%02x%02x%02x", mac[3], mac[4], mac[5]); esp_netif_set_hostname(n, s_host);
    wifi_init_config_t ic = WIFI_INIT_CONFIG_DEFAULT(); esp_wifi_init(&ic);
    esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL);
    esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL);
    wifi_config_t wc = {0}; strncpy((char *)wc.sta.ssid, g_cfg.ssid, 32); strncpy((char *)wc.sta.password, g_cfg.pass, 64);
    unsigned b[6]; if (sscanf(g_cfg.bssid, "%x:%x:%x:%x:%x:%x", &b[0], &b[1], &b[2], &b[3], &b[4], &b[5]) == 6) { for (int i = 0; i < 6; i++) wc.sta.bssid[i] = b[i]; wc.sta.bssid_set = 1; }
    wc.sta.pmf_cfg.capable = true;
    wc.sta.threshold.authmode = g_cfg.pass[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    esp_wifi_set_mode(WIFI_MODE_STA); esp_wifi_set_config(WIFI_IF_STA, &wc); esp_wifi_set_ps(WIFI_PS_NONE); esp_wifi_start();
    s_down_since = esp_timer_get_time(); ap_check(NULL);
    const esp_timer_create_args_t a = { .callback = ap_check, .name = "wifi-ap" }; esp_timer_handle_t t;
    if (esp_timer_create(&a, &t) == ESP_OK) esp_timer_start_periodic(t, 10ULL * 1000000);
}
bool wifi_connected(void) { return s_conn; }
int wifi_rssi(void) { wifi_ap_record_t r; return esp_wifi_sta_get_ap_info(&r) == ESP_OK ? r.rssi : 0; }
const char *wifi_ip(void) { return s_ip; }
