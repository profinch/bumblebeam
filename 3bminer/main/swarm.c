// the board looks for other miners on its own subnet in the background, like NMMiner: one address at a time, a short
// connect, /probe (or /api/system/info for AxeOS), so the Swarm page gets the list from one /alive instead of a browser scan.
// A full pass every 30 minutes (the first a minute after Wi-Fi is up), the known ones re-checked every 2 minutes; it waits
// while an OTA or a camera stream runs. The list (also miners added by hand, e.g. on another subnet) is kept in NVS.
#include "swarm.h"
#include "wifi.h"
#include "camera.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "nvs.h"
#include "lwip/sockets.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include <string.h>
#include <stdio.h>
#include <errno.h>
#include <fcntl.h>
static const char *TAG = "swarm";
volatile bool g_ota_busy;

#define MAXM 32
#define PASS_S (30 * 60)
#define RECHECK_S 120
#define FORGET_S (24 * 3600)
typedef struct { uint32_t ip; int64_t seen; } miner_t;   // ip in network byte order, seen = esp_timer seconds
static miner_t s_m[MAXM]; static int s_n; static SemaphoreHandle_t s_lock;
static int64_t s_last_pass = -1;   // esp_timer seconds of the last full pass, -1 = none yet

static int64_t now_s(void) { return esp_timer_get_time() / 1000000; }
static void save(void) {   // only when the list changes: a miner found or dropped
    uint32_t ips[MAXM]; int n; xSemaphoreTake(s_lock, portMAX_DELAY); n = s_n; for (int i = 0; i < n; i++) ips[i] = s_m[i].ip; xSemaphoreGive(s_lock);
    nvs_handle_t h; if (nvs_open("swarm", NVS_READWRITE, &h) == ESP_OK) { nvs_set_blob(h, "ips", ips, n * sizeof ips[0]); nvs_commit(h); nvs_close(h); }
}
static void load(void) {
    nvs_handle_t h; if (nvs_open("swarm", NVS_READONLY, &h) != ESP_OK) return;
    uint32_t ips[MAXM]; size_t l = sizeof ips; if (nvs_get_blob(h, "ips", ips, &l) == ESP_OK) { s_n = l / sizeof ips[0]; for (int i = 0; i < s_n; i++) { s_m[i].ip = ips[i]; s_m[i].seen = now_s(); } }
    nvs_close(h);
}
static int find(uint32_t ip) { for (int i = 0; i < s_n; i++) if (s_m[i].ip == ip) return i; return -1; }
static bool add(uint32_t ip) {   // true when it is new
    bool nw = false; xSemaphoreTake(s_lock, portMAX_DELAY);
    int i = find(ip); if (i >= 0) s_m[i].seen = now_s(); else if (s_n < MAXM) { s_m[s_n].ip = ip; s_m[s_n].seen = now_s(); s_n++; nw = true; }
    xSemaphoreGive(s_lock); return nw;
}
static bool drop_old(void) {
    bool ch = false; xSemaphoreTake(s_lock, portMAX_DELAY);
    for (int i = 0; i < s_n; ) if (now_s() - s_m[i].seen > FORGET_S) { s_m[i] = s_m[--s_n]; ch = true; } else i++;
    xSemaphoreGive(s_lock); return ch;
}

// GET path from ip:80; true when the answer looks like a miner's (NMMiner/3BMiner /probe has "hr", AxeOS info "hashRate")
static int get(uint32_t ip, const char *path, char *buf, int cap) {
    int s = socket(AF_INET, SOCK_STREAM, 0); if (s < 0) return -1;
    fcntl(s, F_SETFL, fcntl(s, F_GETFL, 0) | O_NONBLOCK);
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(80), .sin_addr.s_addr = ip };
    int n = -1;
    if (connect(s, (struct sockaddr *)&a, sizeof a) == 0 || errno == EINPROGRESS) {
        fd_set w; FD_ZERO(&w); FD_SET(s, &w); struct timeval tv = { .tv_sec = 0, .tv_usec = 300000 };   // a host that is not there costs 0.3 s
        int e = 0; socklen_t el = sizeof e;
        if (select(s + 1, NULL, &w, NULL, &tv) == 1 && getsockopt(s, SOL_SOCKET, SO_ERROR, &e, &el) == 0 && e == 0) {
            fcntl(s, F_SETFL, fcntl(s, F_GETFL, 0) & ~O_NONBLOCK);
            struct timeval rt = { .tv_sec = 2 }; setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &rt, sizeof rt); setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &rt, sizeof rt);
            char q[160]; int ql = snprintf(q, sizeof q, "GET %s HTTP/1.1\r\nHost: " IPSTR "\r\nUser-Agent: 3BMiner-swarm\r\nConnection: close\r\n\r\n", path, IP2STR((esp_ip4_addr_t *)&ip));   // esp_http_server answers HTTP/1.0 with 505
            if (send(s, q, ql, 0) == ql) { n = 0; int k; while (n < cap - 1 && (k = recv(s, buf + n, cap - 1 - n, 0)) > 0) n += k; buf[n] = 0; }
        }
    }
    close(s); return n;
}
static bool is_miner(uint32_t ip) {
    static char b[1024];   // this task only
    int n = get(ip, "/probe", b, sizeof b); if (n <= 0) return false;
    ESP_LOGD(TAG, IPSTR " answered %d bytes: %.40s", IP2STR((esp_ip4_addr_t *)&ip), n, b);
    if (strstr(b, " 200 ") && strstr(b, "\"hr\"")) return true;
    if (strstr(b, " 404 ") && get(ip, "/api/system/info", b, sizeof b) > 0 && strstr(b, " 200 ") && strstr(b, "\"hashRate\"")) return true;   // AxeOS has no /probe
    return false;
}
static bool may_run(void) { return wifi_connected() && !g_ota_busy && !camera_streaming() && heap_caps_get_free_size(MALLOC_CAP_INTERNAL) > 24 * 1024; }

static void task(void *arg) {
    s_lock = xSemaphoreCreateMutex(); load();
    while (!wifi_connected()) vTaskDelay(pdMS_TO_TICKS(1000));
    vTaskDelay(pdMS_TO_TICKS(60000));
    int64_t last_check = 0;
    for (;;) {
        if (s_last_pass < 0 || now_s() - s_last_pass >= PASS_S) {   // a full pass over the own /24
            esp_netif_ip_info_t ii; esp_netif_t *nf = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
            if (nf && esp_netif_get_ip_info(nf, &ii) == ESP_OK && ii.ip.addr) {
                uint32_t self = ii.ip.addr, net = self & htonl(0xFFFFFF00); bool ch = false; int found = 0;
                ESP_LOGI(TAG, "scan of " IPSTR "/24", IP2STR((esp_ip4_addr_t *)&net));
                for (int h = 1; h < 255; h++) {
                    while (!may_run()) vTaskDelay(pdMS_TO_TICKS(2000));
                    uint32_t ip = net | htonl(h); if (ip == self) continue;
                    if (is_miner(ip)) { found++; ch |= add(ip); }
                    vTaskDelay(pdMS_TO_TICKS(50));
                }
                s_last_pass = now_s(); ch |= drop_old(); if (ch) save();
                ESP_LOGI(TAG, "scan done: %d miners answered, %d known", found, s_n);
            }
        }
        if (now_s() - last_check >= RECHECK_S) {   // the known ones, also those on other subnets
            uint32_t ips[MAXM]; int n; xSemaphoreTake(s_lock, portMAX_DELAY); n = s_n; for (int i = 0; i < n; i++) ips[i] = s_m[i].ip; xSemaphoreGive(s_lock);
            for (int i = 0; i < n; i++) { if (!may_run()) break; if (is_miner(ips[i])) add(ips[i]); vTaskDelay(pdMS_TO_TICKS(50)); }
            if (drop_old()) save();
            last_check = now_s();
        }
        vTaskDelay(pdMS_TO_TICKS(5000));
    }
}
void swarm_start(void) { xTaskCreatePinnedToCore(task, "swarm", 4096, NULL, 2, NULL, 1); }
bool swarm_add(uint32_t ip) { if (!s_lock) return false; bool nw = add(ip); if (nw) save(); return true; }
int swarm_alive_json(char *b, int cap, const char *self) {
    int n = snprintf(b, cap, "{\"self\":\"%s\",\"ips\":[\"%s\"", self, self);
    if (s_lock) { xSemaphoreTake(s_lock, portMAX_DELAY);
        for (int i = 0; i < s_n && n < cap - 24; i++) { uint32_t ip = s_m[i].ip; n += snprintf(b + n, cap - n, ",\"" IPSTR "\"", IP2STR((esp_ip4_addr_t *)&ip)); }
        xSemaphoreGive(s_lock); }
    int64_t ago = s_last_pass < 0 ? -1 : now_s() - s_last_pass;
    n += snprintf(b + n, cap - n, "],\"lastScanAgo\":%lld}", (long long)ago);   // seconds since the last full pass, -1 = none yet
    return n;
}
