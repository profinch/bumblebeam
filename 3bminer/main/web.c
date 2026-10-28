#include "esp_wifi.h"
#include "web.h"
#include "config.h"
#include "wifi.h"
#include "miner.h"
#include "stratum.h"
#include "esp_http_server.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_app_desc.h"
#include "esp_mac.h"
#include "cJSON.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <string.h>
#include <stdio.h>
static const char *TAG = "web";
#include "version.h"
#include <time.h>
#include "camera.h"
#include "history.h"
#include "swarm.h"
static char s_host[32];
static void fmt_diff(double d, char *out, int n) { if (d >= 1e12) snprintf(out, n, "%.2fT", d / 1e12); else if (d >= 1e9) snprintf(out, n, "%.2fG", d / 1e9); else if (d >= 1e6) snprintf(out, n, "%.2fM", d / 1e6); else if (d >= 1e3) snprintf(out, n, "%.2fK", d / 1e3); else snprintf(out, n, "%.4g", d); }
// Who may use the board from a browser: its own page, another miner's page on the LAN (the Swarm) and a preview served from
// localhost. A page on the internet open in the same browser may neither read the answers (the wallet and Wi-Fi name are in
// them) nor change anything; "null" (a sandboxed frame, a file) counts as outside. Programs (curl, VLC, Home Assistant) send
// no Origin and no Sec-Fetch-Site and are not affected.
static bool lan_host(const char *host) {
    unsigned a, b; if (sscanf(host, "%u.%u.", &a, &b) == 2) return a == 10 || a == 127 || (a == 192 && b == 168) || (a == 172 && b >= 16 && b <= 31) || (a == 169 && b == 254);
    int k = strlen(host); return k && (!strchr(host, '.') || (k > 6 && !strcmp(host + k - 6, ".local")) || (k > 4 && !strcmp(host + k - 4, ".lan")));   // localhost, a bare name, mDNS
}
// the host of an Origin or Referer value ("http://host:port/..."); false for "null" or an empty one
static bool url_host(const char *v, char *host, int cap) {
    const char *h = strstr(v, "://"); if (!h) return false; h += 3; int k = 0;
    while (h[k] && h[k] != ':' && h[k] != '/' && k < cap - 1) { host[k] = h[k]; k++; } host[k] = 0; return k > 0;
}
static bool from_ok(httpd_req_t *r, const char *v) {
    char host[64]; if (!url_host(v, host, sizeof host)) return false;
    char self[64]; if (httpd_req_get_hdr_value_str(r, "Host", self, sizeof self) == ESP_OK) { char *c = strchr(self, ':'); if (c) *c = 0; if (!strcmp(self, host)) return true; }
    return lan_host(host);
}
static esp_err_t refuse(httpd_req_t *r, const char *from) {
    ESP_LOGW(TAG, "%s from %s refused", r->uri, from); httpd_resp_set_status(r, "403 Forbidden"); return httpd_resp_send(r, "cross-site request refused", -1);
}
// CORS for a JSON answer: only a LAN page may read it (the header names that page's origin)
void web_cors(httpd_req_t *r) {
    static __thread char o[80];   // the header value must outlive this call (httpd sends it later)
    if (httpd_req_get_hdr_value_str(r, "Origin", o, sizeof o) == ESP_OK && from_ok(r, o)) { httpd_resp_set_hdr(r, "Access-Control-Allow-Origin", o); httpd_resp_set_hdr(r, "Vary", "Origin"); }
}
// a POST that changes the board: browsers always send Origin with it; none = a program
bool web_post_allowed(httpd_req_t *r) {
    char o[80]; if (httpd_req_get_hdr_value_str(r, "Origin", o, sizeof o) != ESP_OK || from_ok(r, o)) return true;
    refuse(r, o); return false;
}
// a GET that changes something (camera controls, the engine check): an <img> or a link on another site would do it, the
// browser marks those "cross-site"; they pass only when the page they come from is on the LAN
bool web_get_allowed(httpd_req_t *r) {
    char v[96]; if (httpd_req_get_hdr_value_str(r, "Sec-Fetch-Site", v, sizeof v) != ESP_OK || strcmp(v, "cross-site")) return true;
    if (httpd_req_get_hdr_value_str(r, "Origin", v, sizeof v) == ESP_OK && from_ok(r, v)) return true;
    if (httpd_req_get_hdr_value_str(r, "Referer", v, sizeof v) == ESP_OK && from_ok(r, v)) return true;
    refuse(r, "another site"); return false;
}
static uint32_t uptime_s(void) { return (uint32_t)(esp_timer_get_time() / 1000000); }

static esp_err_t h_probe(httpd_req_t *r) {
    char b[320]; snprintf(b, sizeof b, "{\"model\":\"NMMiner\",\"hostname\":\"%s\",\"ver\":\"%s\",\"sw\":0,\"sh\":0,\"hr\":%.0f,\"sbd\":%.0f,\"ebd\":%.0f,\"ut\":%u}", s_host, FW_VERSION, g_miner.hashrate + g_miner.sw_hashrate, g_stratum.best_session, g_stratum.best_ever, (unsigned)uptime_s());
    httpd_resp_set_type(r, "application/json"); web_cors(r); return httpd_resp_send(r, b, -1);
}
// NMMiner's /alive: this board and the miners its background search found (swarm.c), with the time since the last pass
static esp_err_t h_alive(httpd_req_t *r) { static char b[700]; swarm_alive_json(b, sizeof b, wifi_ip()); httpd_resp_set_type(r, "application/json"); web_cors(r); return httpd_resp_send(r, b, -1); }
// POST /api/swarm/add {"ip":"a.b.c.d"}: a miner the board keeps checking (e.g. on another subnet)
static esp_err_t h_swarm_add(httpd_req_t *r) {
    if (!web_post_allowed(r)) return ESP_OK;
    char buf[96]; int n = httpd_req_recv(r, buf, sizeof buf - 1); if (n <= 0) return httpd_resp_send_500(r); buf[n] = 0;
    unsigned a, b, c, d; char *p = strstr(buf, "\"ip\""); uint32_t ip = 0;
    if (p && (p = strchr(p + 4, '"')) && sscanf(p + 1, "%u.%u.%u.%u", &a, &b, &c, &d) == 4 && a < 256 && b < 256 && c < 256 && d < 256) ip = a | b << 8 | c << 16 | d << 24;
    httpd_resp_set_type(r, "application/json"); web_cors(r);
    if (!ip) { httpd_resp_set_status(r, "400 Bad Request"); return httpd_resp_send(r, "{\"status\":\"ip like 192.168.1.50\"}", -1); }
    return httpd_resp_send(r, swarm_add(ip) ? "{\"status\":\"ok\"}" : "{\"status\":\"not ready\"}", -1);
}
static esp_err_t h_info(httpd_req_t *r) {
    char nd[24], pd[24], ld[24], bs[24], be[24]; if (g_stratum.net_diff > 0) fmt_diff(g_stratum.net_diff, nd, sizeof nd); else strcpy(nd, "-"); fmt_diff(g_stratum.pool_diff, pd, sizeof pd); fmt_diff(g_stratum.last_share_diff, ld, sizeof ld); fmt_diff(g_stratum.best_session, bs, sizeof bs); fmt_diff(g_stratum.best_ever, be, sizeof be);
    char lr[96]; int k = 0; for (const char *q = g_stratum.last_reject; *q && k < 90; q++) if (*q != '"' && *q != '\\') lr[k++] = *q; lr[k] = 0;
    char b[2200];
    snprintf(b, sizeof b,
        "{\"identity\":{\"hwModel\":\"NMMiner\",\"hostName\":\"%s\",\"fwVersion\":\"%s\",\"rssi\":%d,\"displayName\":\"3BMiner\",\"time\":%lld,\"tz\":\"%s\",\"ntp\":\"%s\",\"ntpSync\":%lld,\"build\":\"%s %s\",\"idf\":\"%s\",\"slot\":\"%s\",\"board\":\"" CONFIG_BOARD_NAME "\",\"boardId\":\"" CONFIG_BOARD_ID "\",\"camera\":%s,\"mining\":%s},"
        "\"miner\":{\"hashRate\":%.6f,\"sAccepted\":%u,\"sRejected\":%u,\"uptimeSeconds\":%u,\"uptimeEver\":%u,\"networkDiff\":\"%s\",\"poolDiff\":\"%s\",\"lastDiff\":\"%s\",\"bestDiffSession\":\"%s\",\"bestDiffEver\":\"%s\",\"blkhits\":0,\"resetReason\":%d,\"restartWhy\":\"%s\",\"freeHeap\":%u,\"minFreeHeap\":%u,\"freeInternal\":%u,\"kernelCycles\":%u,\"kernel\":%u,\"timing\":\"%u/%u/%u/%u/%u\",\"hashRateEngine\":%.6f,\"hashRateSw\":%.6f,\"candidates\":%u,\"totalHashes\":%llu,\"swHashes\":%llu,\"avg1hKhs\":%.1f,\"avg24hKhs\":%.1f,\"avgAllKhs\":%.1f,\"allSeconds\":%u,\"historyMinutes\":%u},"
        "\"stratum\":{\"url\":\"%s\",\"solo\":%s,\"authorized\":%s,\"user\":\"%s\",\"connected\":%s,\"jobs\":%u,\"submitted\":%u,\"candDropped\":%u,\"staleDropped\":%u,\"oldJobSubmits\":%u,\"rejStale\":%u,\"rejDup\":%u,\"rejLowDiff\":%u,\"rejOther\":%u,\"lastReject\":\"%s\"},\"temps\":{\"vcore\":null,\"asic\":null},\"storage\":{\"fsTotal\":0,\"fsUsed\":0}}",
        s_host, FW_VERSION, wifi_rssi(), (long long)(time(NULL) > 1700000000 ? time(NULL) : 0), g_cfg.tz, g_ntp_server, (long long)g_ntp_sync, esp_app_get_description()->date, esp_app_get_description()->time, esp_app_get_description()->idf_ver, esp_ota_get_running_partition() ? esp_ota_get_running_partition()->label : "?", CONFIG_BOARD_HAS_CAMERA_STR, g_cfg.mining ? "true" : "false", (g_miner.hashrate + g_miner.sw_hashrate) / 1e9, (unsigned)g_stratum.accepted, (unsigned)g_stratum.rejected, (unsigned)uptime_s(), (unsigned)uptime_s(), nd, pd, ld, bs, be, (int)esp_reset_reason(), main_restart_why(),
        (unsigned)esp_get_free_heap_size(), (unsigned)esp_get_minimum_free_heap_size(), (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL), (unsigned)g_miner.kernel_cycles, (unsigned)g_kernel, (unsigned)g_timing[0], (unsigned)g_timing[1], (unsigned)g_timing[2], (unsigned)g_timing[3], (unsigned)g_timing[4], g_miner.hashrate / 1e9, g_miner.sw_hashrate / 1e9, (unsigned)g_miner.candidates, (unsigned long long)g_miner.total_hashes, (unsigned long long)g_miner.sw_hashes, history_avg_khs(60), history_avg_khs(HISTORY_MINUTES), history_avg_all_khs(), (unsigned)history_all_seconds(), (unsigned)history_count(),
        g_stratum.pool_desc, g_stratum.solo < 0 ? "null" : g_stratum.solo ? "true" : "false", g_stratum.authorized < 0 ? "null" : g_stratum.authorized ? "true" : "false", g_stratum.user, g_stratum.connected ? "true" : "false", (unsigned)g_stratum.jobs, (unsigned)g_stratum.submitted,
        (unsigned)g_stratum.cand_dropped, (unsigned)g_stratum.stale_dropped, (unsigned)g_stratum.old_job_submits, (unsigned)g_stratum.rej_stale, (unsigned)g_stratum.rej_dup, (unsigned)g_stratum.rej_lowdiff, (unsigned)g_stratum.rej_other, lr);
    httpd_resp_set_type(r, "application/json"); web_cors(r); return httpd_resp_send(r, b, -1);
}
static esp_err_t h_swbench(httpd_req_t *r) {   // GET /api/swbench: software sha256d cost on core 1
    int ok = 0; uint32_t c = sw_bench_cycles(&ok); char b[128]; snprintf(b, sizeof b, "{\"cyclesPerHash\":%u,\"khsOneCore\":%.1f,\"correct\":%s}", (unsigned)c, 240000.0 / c, ok ? "true" : "false");
    httpd_resp_set_type(r, "application/json"); return httpd_resp_send(r, b, -1);
}
static esp_err_t h_bench(httpd_req_t *r) {   // GET /api/bench?t=W1,W2,W3,L1,L2&n=NONCES[&apply=1]
    if (!web_get_allowed(r)) return ESP_OK;
    httpd_resp_set_type(r, "application/json"); web_cors(r);
    if (!g_cfg.mining) { httpd_resp_set_status(r, "409 Conflict"); return httpd_resp_send(r, "{\"error\":\"mining is off\"}", -1); }
    char q[128] = "", v[48]; httpd_req_get_url_query_str(r, q, sizeof q);
    uint32_t t[5]; for (int i = 0; i < 5; i++) t[i] = g_timing[i];
    if (httpd_query_key_value(q, "t", v, sizeof v) == ESP_OK) sscanf(v, "%u,%u,%u,%u,%u", (unsigned *)&t[0], (unsigned *)&t[1], (unsigned *)&t[2], (unsigned *)&t[3], (unsigned *)&t[4]);
    uint32_t k = g_kernel; if (httpd_query_key_value(q, "k", v, sizeof v) == ESP_OK) k = strtoul(v, NULL, 10);
    if (!miner_kernel_ok(k)) { httpd_resp_set_status(r, "400 Bad Request"); return httpd_resp_send(r, "{\"error\":\"kernel 0 or 3\"}", -1); }
    if (httpd_query_key_value(q, "sw", v, sizeof v) == ESP_OK) g_sw_enabled = strtoul(v, NULL, 10) != 0;
    uint32_t n = 262144; if (httpd_query_key_value(q, "n", v, sizeof v) == ESP_OK) n = strtoul(v, NULL, 10); if (n < 16384) n = 16384; if (n > 16777216) n = 16777216;
    for (int i = 0; i < 5; i++) if (t[i] > 200) t[i] = 200;
    memcpy(g_bench.t, t, sizeof t); g_bench.n = n; g_bench.k = k; g_bench.apply = httpd_query_key_value(q, "apply", v, sizeof v) == ESP_OK; g_bench.done = 0; g_bench.req = 1;
    for (int i = 0; i < 600 && !g_bench.done; i++) vTaskDelay(pdMS_TO_TICKS(100));
    char b[256]; snprintf(b, sizeof b, "{\"k\":%u,\"t\":[%u,%u,%u,%u,%u],\"n\":%u,\"done\":%s,\"cycPerNonce\":%.3f,\"hits\":%u,\"bad\":%u,\"sum\":\"%08x\",\"live\":[%u,%u,%u,%u,%u],\"liveKernel\":%u}",
        (unsigned)k, (unsigned)t[0], (unsigned)t[1], (unsigned)t[2], (unsigned)t[3], (unsigned)t[4], (unsigned)n, g_bench.done ? "true" : "false", g_bench.cyc_per_kn / 1000.0, (unsigned)g_bench.hits, (unsigned)g_bench.bad, (unsigned)g_bench.sum,
        (unsigned)g_timing[0], (unsigned)g_timing[1], (unsigned)g_timing[2], (unsigned)g_timing[3], (unsigned)g_timing[4], (unsigned)g_kernel);
    return httpd_resp_send(r, b, -1);
}
static esp_err_t h_history(httpd_req_t *r) {   // GET /api/history: {"step":60,"khs":[oldest .. newest]}, one value a minute, up to 24 h
    httpd_resp_set_type(r, "application/json"); web_cors(r);
    char b[600]; int n = snprintf(b, sizeof b, "{\"step\":60,\"khs\":["); uint32_t c = history_count();
    for (uint32_t i = 0; i < c; i++) { n += snprintf(b + n, sizeof b - n, i ? ",%u" : "%u", history_get(i)); if (n > 500) { httpd_resp_send_chunk(r, b, n); n = 0; } }
    n += snprintf(b + n, sizeof b - n, "]}"); httpd_resp_send_chunk(r, b, n); return httpd_resp_send_chunk(r, NULL, 0);
}
static esp_err_t h_wifiscan(httpd_req_t *r) {   // GET /api/wifi/scan: access points in reach, strongest first, for the settings' AP lock list
    httpd_resp_set_type(r, "application/json"); web_cors(r);
    wifi_scan_config_t sc = { .show_hidden = false };
    if (esp_wifi_scan_start(&sc, true) != ESP_OK) return httpd_resp_send(r, "{\"aps\":[],\"error\":\"scan failed\"}", -1);
    uint16_t n = 20; wifi_ap_record_t *ap = calloc(n, sizeof *ap); if (!ap) return httpd_resp_send_500(r);
    esp_wifi_scan_get_ap_records(&n, ap);
    char b[160]; httpd_resp_send_chunk(r, "{\"aps\":[", -1);
    for (int i = 0; i < n; i++) {
        char ss[66]; int k = 0; for (const char *q = (const char *)ap[i].ssid; *q && k < 64; q++) if (*q != '"' && *q != '\\' && (unsigned char)*q >= 32) ss[k++] = *q; ss[k] = 0;
        int l = snprintf(b, sizeof b, "%s{\"ssid\":\"%s\",\"bssid\":\"%02x:%02x:%02x:%02x:%02x:%02x\",\"rssi\":%d,\"ch\":%u}", i ? "," : "", ss,
            ap[i].bssid[0], ap[i].bssid[1], ap[i].bssid[2], ap[i].bssid[3], ap[i].bssid[4], ap[i].bssid[5], ap[i].rssi, ap[i].primary);
        httpd_resp_send_chunk(r, b, l);
    }
    free(ap); httpd_resp_send_chunk(r, "]}", -1); return httpd_resp_send_chunk(r, NULL, 0);
}
static esp_err_t h_ok(httpd_req_t *r) { httpd_resp_set_type(r, "application/json"); web_cors(r); return httpd_resp_send(r, "{\"status\":\"ok\"}", -1); }
static void restart_later(void *a) { vTaskDelay(pdMS_TO_TICKS(600)); esp_restart(); }
static esp_err_t h_restart(httpd_req_t *r) { if (!web_post_allowed(r)) return ESP_OK; h_ok(r); xTaskCreate(restart_later, "rst", 2048, NULL, 5, NULL); return ESP_OK; }
static esp_err_t h_config_get(httpd_req_t *r) {
    char b[640]; snprintf(b, sizeof b, "{\"ssid\":\"%s\",\"bssid\":\"%s\",\"pool\":\"%s\",\"port\":%u,\"wallet\":\"%s\",\"worker\":\"%s\",\"suggest\":%g,\"mining\":%s,\"tz\":\"%s\"}", g_cfg.ssid, g_cfg.bssid, g_cfg.pool, g_cfg.port, g_cfg.wallet, g_cfg.worker, g_cfg.suggest, g_cfg.mining ? "true" : "false", g_cfg.tz);
    httpd_resp_set_type(r, "application/json"); web_cors(r); return httpd_resp_send(r, b, -1);
}
static esp_err_t bad(httpd_req_t *r, const char *status, const char *msg) { httpd_resp_set_status(r, status); web_cors(r); return httpd_resp_send(r, msg, -1); }
static esp_err_t h_config_post(httpd_req_t *r) {   // every value checked before any is taken: a refused request changes nothing
    if (!web_post_allowed(r)) return ESP_OK;
    char buf[1024]; int len = r->content_len, got = 0; if (len <= 0 || len >= (int)sizeof buf) return bad(r, "400 Bad Request", "body empty or over 1 KB");
    for (int tries = 0; got < len && tries < 20; ) { int n = httpd_req_recv(r, buf + got, len - got); if (n == HTTPD_SOCK_ERR_TIMEOUT) { tries++; continue; } if (n <= 0) return httpd_resp_send_500(r); got += n; }
    if (got < len) return bad(r, "408 Request Timeout", "body incomplete");
    buf[got] = 0;
    cJSON *j = cJSON_Parse(buf); if (!j) return bad(r, "400 Bad Request", "bad json");
    miner_cfg_t c = g_cfg; const char *err = NULL; cJSON *x;
    // strings land in JSON answers and stratum lines as they are: no quotes, backslashes or control characters (the password only goes to Wi-Fi)
    #define S(k, f, plain) if (!err && (x = cJSON_GetObjectItem(j, k))) { if (!cJSON_IsString(x) || strlen(x->valuestring) >= sizeof c.f) err = k " too long or not a string"; \
        else { if (plain) for (const char *q = x->valuestring; *q; q++) if (*q == '"' || *q == '\\' || (unsigned char)*q < 32) err = k " has quotes, backslashes or control characters"; \
               if (!err) strcpy(c.f, x->valuestring); } }
    S("ssid", ssid, true) S("pass", pass, false) S("bssid", bssid, true) S("pool", pool, true) S("wallet", wallet, true) S("worker", worker, true) S("tz", tz, true)
    #undef S
    if (!err && (x = cJSON_GetObjectItem(j, "port"))) { if (!cJSON_IsNumber(x) || x->valueint < 1 || x->valueint > 65535) err = "port 1..65535"; else c.port = x->valueint; }
    if (!err && (x = cJSON_GetObjectItem(j, "suggest"))) { if (!cJSON_IsNumber(x) || !(x->valuedouble >= 0 && x->valuedouble <= 1e12)) err = "suggest: a difficulty, 0 or more"; else c.suggest = x->valuedouble; }
    if (!err && (x = cJSON_GetObjectItem(j, "mining"))) { if (!cJSON_IsBool(x)) err = "mining: true or false"; else c.mining = cJSON_IsTrue(x); }
    cJSON_Delete(j);
    if (err) { char m[96]; snprintf(m, sizeof m, "{\"status\":\"%s\"}", err); httpd_resp_set_type(r, "application/json"); return bad(r, "400 Bad Request", m); }
    g_cfg = c; bool ok = config_save();
    httpd_resp_set_type(r, "application/json"); web_cors(r); httpd_resp_send(r, ok ? "{\"status\":\"ok\",\"note\":\"restarting\"}" : "{\"status\":\"nvs error\"}", -1);
    if (ok) xTaskCreate(restart_later, "rst", 2048, NULL, 5, NULL);
    return ESP_OK;
}
// an image names its board as "3BMINER_BOARD=<id>;" (version.h); an upload naming another board is refused
static const char s_marker[] = FW_BOARD_MARKER;
static int marker_scan(const char *buf, int n, char *tail, int *tl) {   // 1 = ours, -1 = other board, 0 = not seen yet
    static const char key[] = "3BMINER_BOARD="; static char w[96 + 4096];   // static: httpd runs one request at a time
    int wl = *tl; memcpy(w, tail, wl); memcpy(w + wl, buf, n); wl += n;
    int res = 0;
    // only "key<id>;" with id = [a-z0-9_-]+ counts: the key itself also sits in this code as a bare string
    for (int i = 0; i + (int)sizeof key - 1 <= wl; i++) if (!memcmp(w + i, key, sizeof key - 1)) {
        int j = i + sizeof key - 1; while (j < wl && ((w[j] >= 'a' && w[j] <= 'z') || (w[j] >= '0' && w[j] <= '9') || w[j] == '_' || w[j] == '-')) j++;
        if (j == i + (int)sizeof key - 1 || j >= wl || w[j] != ';') continue;
        res = (j - i + 1 == (int)sizeof s_marker - 1 && !memcmp(w + i, s_marker, sizeof s_marker - 1)) ? 1 : -1; if (res < 0) break; }
    int keep = wl < 96 ? wl : 96; memcpy(tail, w + wl - keep, keep); *tl = keep; return res;
}
// a failed upload: the camera comes back by a restart (restarting the driver in place did not always work)
static void ota_failed(void) {
    g_ota_busy = false;
#ifdef CONFIG_BOARD_HAS_CAMERA
    xTaskCreate(restart_later, "rst", 2048, NULL, 5, NULL);
#endif
}
static esp_err_t h_update(httpd_req_t *r) {   // POST raw firmware image
    if (!web_post_allowed(r)) return ESP_OK;
    const esp_partition_t *part = esp_ota_get_next_update_partition(NULL); if (!part) return httpd_resp_send_500(r);
    if (r->content_len < 65536 || r->content_len > part->size) return bad(r, "400 Bad Request", "no image or larger than the slot");
    char *buf = malloc(4096); if (!buf) return httpd_resp_send_500(r);
    g_ota_busy = true; camera_stop();   // no-op without a camera; on a camera board the image is written with the sensor off, a restart follows anyway
    // erased sector by sector as the image arrives: no seconds-long erase up front with the cache off and Wi-Fi waiting
    esp_ota_handle_t h; if (esp_ota_begin(part, OTA_WITH_SEQUENTIAL_WRITES, &h) != ESP_OK) { free(buf); ota_failed(); return httpd_resp_send_500(r); }
    int remaining = r->content_len, total = 0, waits = 0; char tail[96]; int tl = 0, mk = 0;
    ESP_LOGI(TAG, "OTA start, %d bytes -> %s", remaining, part->label);
    while (remaining > 0) { int n = httpd_req_recv(r, buf, remaining > 4096 ? 4096 : remaining); if (n <= 0) { if (n == HTTPD_SOCK_ERR_TIMEOUT && ++waits < 10) continue; esp_ota_abort(h); free(buf); ota_failed(); return httpd_resp_send_500(r); }
        waits = 0;
        if (mk == 0 || mk == 1) { int m = marker_scan(buf, n, tail, &tl); if (m) mk = m; }
        if (mk < 0) { esp_ota_abort(h); free(buf); ota_failed(); httpd_resp_set_status(r, "409 Conflict"); web_cors(r); return httpd_resp_send(r, "image is for another board (this is " CONFIG_BOARD_ID ")", -1); }
        if (esp_ota_write(h, buf, n) != ESP_OK) { esp_ota_abort(h); free(buf); ota_failed(); httpd_resp_set_status(r, "500 Internal Server Error"); return httpd_resp_send(r, "ota write failed", -1); } remaining -= n; total += n; }
    free(buf);
    if (!mk) ESP_LOGW(TAG, "OTA image has no board marker (pre-0.6 build?), accepted");
    if (esp_ota_end(h) != ESP_OK || esp_ota_set_boot_partition(part) != ESP_OK) { ota_failed(); httpd_resp_set_status(r, "500 Internal Server Error"); return httpd_resp_send(r, "ota end/validate failed", -1); }
    char b[96]; snprintf(b, sizeof b, "{\"status\":\"ok\",\"bytes\":%d,\"partition\":\"%s\",\"note\":\"restarting\"}", total, part->label);
    httpd_resp_set_type(r, "application/json"); web_cors(r); httpd_resp_send(r, b, -1); xTaskCreate(restart_later, "rst", 2048, NULL, 5, NULL); return ESP_OK;
}
extern const uint8_t www_gz_start[] asm("_binary_index_html_gz_start"), www_gz_end[] asm("_binary_index_html_gz_end"),
    fav_gz_start[] asm("_binary_favicon_svg_gz_start"), fav_gz_end[] asm("_binary_favicon_svg_gz_end");   // main/www (web-next/build.py), gzipped by the build
// the page is part of the image: its ETag is the image's SHA-256 (the build time stays the same in incremental builds),
// and the browser asks every time (no-cache) - an unchanged page
// costs a 304, an updated firmware shows its own page at once instead of the cached one for 5 minutes
static esp_err_t h_root(httpd_req_t *r) {
    static char etag[24]; if (!etag[0]) { char h[17]; esp_app_get_elf_sha256(h, sizeof h); snprintf(etag, sizeof etag, "\"%s\"", h); }
    char inm[48]; httpd_resp_set_hdr(r, "ETag", etag); httpd_resp_set_hdr(r, "Cache-Control", "no-cache");
    if (httpd_req_get_hdr_value_str(r, "If-None-Match", inm, sizeof inm) == ESP_OK && !strcmp(inm, etag)) { httpd_resp_set_status(r, "304 Not Modified"); return httpd_resp_send(r, NULL, 0); }
    httpd_resp_set_type(r, "text/html"); httpd_resp_set_hdr(r, "Content-Encoding", "gzip"); return httpd_resp_send(r, (const char *)www_gz_start, www_gz_end - www_gz_start); }
static esp_err_t h_favicon(httpd_req_t *r) { httpd_resp_set_type(r, "image/svg+xml"); httpd_resp_set_hdr(r, "Content-Encoding", "gzip"); httpd_resp_set_hdr(r, "Cache-Control", "max-age=86400"); return httpd_resp_send(r, (const char *)fav_gz_start, fav_gz_end - fav_gz_start); }
void web_start(void) {
    uint8_t mac[6]; esp_read_mac(mac, ESP_MAC_WIFI_STA); snprintf(s_host, sizeof s_host, CONFIG_BOARD_HOST_PREFIX "-%02x%02x%02x", mac[3], mac[4], mac[5]);
    httpd_config_t c = HTTPD_DEFAULT_CONFIG(); c.core_id = 1; c.max_uri_handlers = 24 + camera_http_handler_count(); c.stack_size = 8192; c.lru_purge_enable = true; c.max_open_sockets = 5;   // 5 + 3 httpd internal + stratum stays well under LWIP_MAX_SOCKETS=16
    httpd_handle_t s; if (httpd_start(&s, &c) != ESP_OK) { ESP_LOGE(TAG, "httpd start failed"); return; }
    httpd_uri_t u[] = {
        { .uri = "/", .method = HTTP_GET, .handler = h_root }, { .uri = "/swarm", .method = HTTP_GET, .handler = h_root }, { .uri = "/settings", .method = HTTP_GET, .handler = h_root }, { .uri = "/firmware", .method = HTTP_GET, .handler = h_root }, { .uri = "/favicon.svg", .method = HTTP_GET, .handler = h_favicon }, { .uri = "/favicon.ico", .method = HTTP_GET, .handler = h_favicon }, { .uri = "/probe", .method = HTTP_GET, .handler = h_probe }, { .uri = "/alive", .method = HTTP_GET, .handler = h_alive },
        { .uri = "/api/system/info", .method = HTTP_GET, .handler = h_info }, { .uri = "/api/system/restart", .method = HTTP_POST, .handler = h_restart },
        { .uri = "/api/swarm/find", .method = HTTP_POST, .handler = h_ok }, { .uri = "/api/config", .method = HTTP_GET, .handler = h_config_get }, { .uri = "/api/config", .method = HTTP_POST, .handler = h_config_post },
        { .uri = "/api/bench", .method = HTTP_GET, .handler = h_bench }, { .uri = "/api/history", .method = HTTP_GET, .handler = h_history }, { .uri = "/api/wifi/scan", .method = HTTP_GET, .handler = h_wifiscan }, { .uri = "/api/swbench", .method = HTTP_GET, .handler = h_swbench }, { .uri = "/api/swarm/add", .method = HTTP_POST, .handler = h_swarm_add }, { .uri = "/update", .method = HTTP_POST, .handler = h_update } };
    for (unsigned i = 0; i < sizeof u / sizeof u[0]; i++) httpd_register_uri_handler(s, &u[i]);
    camera_register_http(s);
#ifdef CONFIG_BOARD_HAS_CAMERA
    const httpd_uri_t cp = { .uri = "/camera", .method = HTTP_GET, .handler = h_root }; httpd_register_uri_handler(s, &cp);   // the page's Camera tab
#endif
}
