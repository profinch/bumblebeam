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
#include <stdlib.h>
static const char *TAG = "swarm";
volatile bool g_ota_busy; volatile int g_web_long;

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
        fd_set w; FD_ZERO(&w); FD_SET(s, &w); struct timeval tv = { .tv_sec = 0, .tv_usec = 800000 };   // 0.8 s: a peer on Wi-Fi power save answers ARP late; an absent host costs that
        int e = 0; socklen_t el = sizeof e;
        if (select(s + 1, NULL, &w, NULL, &tv) == 1 && getsockopt(s, SOL_SOCKET, SO_ERROR, &e, &el) == 0 && e == 0) {
            fcntl(s, F_SETFL, fcntl(s, F_GETFL, 0) & ~O_NONBLOCK);
            struct timeval rt = { .tv_sec = 2 }; setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &rt, sizeof rt); setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &rt, sizeof rt);
            char q[160]; int ql = snprintf(q, sizeof q, "GET %s HTTP/1.1\r\nHost: " IPSTR "\r\nUser-Agent: 3BMiner-swarm\r\nConnection: close\r\n\r\n", path, IP2STR((esp_ip4_addr_t *)&ip));   // esp_http_server answers HTTP/1.0 with 505
            if (send(s, q, ql, 0) == ql) { n = 0; int k;
                while (n < cap - 1 && (k = recv(s, buf + n, cap - 1 - n, 0)) > 0) { n += k; buf[n] = 0;   // done once Content-Length bytes follow the headers
                    char *e = strstr(buf, "\r\n\r\n"), *cl = strcasestr(buf, "Content-Length:"); if (e && cl && cl < e && n - (e + 4 - buf) >= atoi(cl + 15)) break; } }
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

// hosts with port 80 open on net (a /24, network order), 8 connects at a time with 0.8 s each (~26 s for 254 addresses);
// then the miner test on the open ones only. A pass the page asks for (another subnet) runs the same way.
#define PAR 8
static volatile uint32_t s_req_net, s_at; static volatile bool s_scanning;   // s_at: the address a pass is at, for the page
static int pass(uint32_t net, uint32_t self) {
    int found = 0; bool ch = false; s_scanning = true;
    for (int h0 = 1; h0 < 255; h0 += PAR) {
        while (!may_run()) vTaskDelay(pdMS_TO_TICKS(2000));
        s_at = net | htonl(h0);
        int fd[PAR]; uint32_t ip[PAR]; int k = 0; fd_set w; FD_ZERO(&w); int mx = -1;
        for (int h = h0; h < h0 + PAR && h < 255; h++) {
            uint32_t a = net | htonl(h); if (a == self) continue;
            int s = socket(AF_INET, SOCK_STREAM, 0); if (s < 0) break;
            fcntl(s, F_SETFL, fcntl(s, F_GETFL, 0) | O_NONBLOCK);
            struct sockaddr_in sa = { .sin_family = AF_INET, .sin_port = htons(80), .sin_addr.s_addr = a };
            if (connect(s, (struct sockaddr *)&sa, sizeof sa) != 0 && errno != EINPROGRESS) { close(s); continue; }
            fd[k] = s; ip[k] = a; k++; FD_SET(s, &w); if (s > mx) mx = s;
        }
        int64_t end = esp_timer_get_time() + 800000; uint32_t open[PAR]; int no = 0; bool done[PAR] = {0};
        while (no + 0 < k) {   // until every socket answered or the 0.8 s are up
            int64_t left = end - esp_timer_get_time(); if (left <= 0) break;
            fd_set ww = w; struct timeval tv = { .tv_sec = 0, .tv_usec = left };
            if (select(mx + 1, NULL, &ww, NULL, &tv) <= 0) break;
            int ready = 0;
            for (int i = 0; i < k; i++) if (!done[i] && FD_ISSET(fd[i], &ww)) { done[i] = true; FD_CLR(fd[i], &w); ready++;
                int e = 0; socklen_t el = sizeof e; if (getsockopt(fd[i], SOL_SOCKET, SO_ERROR, &e, &el) == 0 && e == 0) open[no++] = ip[i]; }
            bool all = true; for (int i = 0; i < k; i++) if (!done[i]) all = false; if (all) break;
        }
        for (int i = 0; i < k; i++) close(fd[i]);
        for (int i = 0; i < no; i++) if (is_miner(open[i])) { found++; ch |= add(open[i]); }
    }
    s_last_pass = now_s(); ch |= drop_old(); if (ch) save(); s_scanning = false;
    return found;
}
static void task(void *arg) {
    s_lock = xSemaphoreCreateMutex(); load();
    while (!wifi_connected()) vTaskDelay(pdMS_TO_TICKS(1000));
    int64_t last_check = 0, last_own = -1, start = now_s();
    for (;;) {
        uint32_t self = 0; esp_netif_ip_info_t ii; esp_netif_t *nf = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
        if (nf && esp_netif_get_ip_info(nf, &ii) == ESP_OK) self = ii.ip.addr;
        if (s_req_net) {   // asked for by the page
            uint32_t net = s_req_net; s_req_net = 0;
            ESP_LOGI(TAG, "scan of " IPSTR "/24 (asked)", IP2STR((esp_ip4_addr_t *)&net));
            ESP_LOGI(TAG, "scan done: %d miners", pass(net, self));
        } else if (self && now_s() - start >= 60 && (last_own < 0 || now_s() - last_own >= PASS_S)) {   // the own /24
            uint32_t net = self & htonl(0xFFFFFF00);
            ESP_LOGI(TAG, "scan of " IPSTR "/24", IP2STR((esp_ip4_addr_t *)&net));
            ESP_LOGI(TAG, "scan done: %d miners, %d known", pass(net, self), s_n); last_own = now_s();
        }
        if (now_s() - last_check >= RECHECK_S) {   // the known ones, also those on other subnets
            uint32_t ips[MAXM]; int n; xSemaphoreTake(s_lock, portMAX_DELAY); n = s_n; for (int i = 0; i < n; i++) ips[i] = s_m[i].ip; xSemaphoreGive(s_lock);
            for (int i = 0; i < n; i++) { if (!may_run() || s_req_net) break; if (is_miner(ips[i])) add(ips[i]); vTaskDelay(pdMS_TO_TICKS(50)); }
            if (drop_old()) save();
            last_check = now_s();
        }
        for (int i = 0; i < 50 && !s_req_net; i++) vTaskDelay(pdMS_TO_TICKS(100));   // 5 s, or at once when a scan is asked for
    }
}
void swarm_start(void) { xTaskCreatePinnedToCore(task, "swarm", 4096, NULL, 2, NULL, 1); }
bool swarm_scan(uint32_t net) { if (!s_lock || !net) return false; s_req_net = net & htonl(0xFFFFFF00); s_scanning = true; return true; }
bool swarm_forget(uint32_t ip) {
    if (!s_lock) return false;
    bool had = false; xSemaphoreTake(s_lock, portMAX_DELAY);
    int i = find(ip); if (i >= 0) { s_m[i] = s_m[--s_n]; had = true; }
    xSemaphoreGive(s_lock); if (had) save(); return true;
}
bool swarm_add(uint32_t ip) { if (!s_lock) return false; bool nw = add(ip); if (nw) save(); return true; }
int swarm_alive_json(char *b, int cap, const char *self) {
    int n = snprintf(b, cap, "{\"self\":\"%s\",\"ips\":[\"%s\"", self, self);
    if (s_lock) { xSemaphoreTake(s_lock, portMAX_DELAY);
        for (int i = 0; i < s_n && n < cap - 24; i++) { uint32_t ip = s_m[i].ip; n += snprintf(b + n, cap - n, ",\"" IPSTR "\"", IP2STR((esp_ip4_addr_t *)&ip)); }
        xSemaphoreGive(s_lock); }
    int64_t ago = s_last_pass < 0 ? -1 : now_s() - s_last_pass;
    uint32_t at = s_at;
    n += snprintf(b + n, cap - n, "],\"scanning\":%s,\"lastScanAgo\":%lld", s_scanning ? "true" : "false", (long long)ago);   // seconds since the last pass, -1 = none yet
    if (s_scanning && at) n += snprintf(b + n, cap - n, ",\"scanAt\":\"" IPSTR "\"", IP2STR((esp_ip4_addr_t *)&at));   // where the pass is
    n += snprintf(b + n, cap - n, "}");
    return n;
}
