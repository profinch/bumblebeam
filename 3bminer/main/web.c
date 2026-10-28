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
#include "camera.h"
static char s_host[32];
static void fmt_diff(double d, char *out, int n) { if (d >= 1e12) snprintf(out, n, "%.2fT", d / 1e12); else if (d >= 1e9) snprintf(out, n, "%.2fG", d / 1e9); else if (d >= 1e6) snprintf(out, n, "%.2fM", d / 1e6); else if (d >= 1e3) snprintf(out, n, "%.2fK", d / 1e3); else snprintf(out, n, "%.4g", d); }
static uint32_t uptime_s(void) { return (uint32_t)(esp_timer_get_time() / 1000000); }

static esp_err_t h_probe(httpd_req_t *r) {
    char b[320]; snprintf(b, sizeof b, "{\"model\":\"NMMiner\",\"hostname\":\"%s\",\"ver\":\"%s\",\"sw\":0,\"sh\":0,\"hr\":%.0f,\"sbd\":%.0f,\"ebd\":%.0f,\"ut\":%u}", s_host, FW_VERSION, g_miner.hashrate + g_miner.sw_hashrate, g_stratum.best_session, g_stratum.best_ever, (unsigned)uptime_s());
    httpd_resp_set_type(r, "application/json"); httpd_resp_set_hdr(r, "Access-Control-Allow-Origin", "*"); return httpd_resp_send(r, b, -1);
}
static esp_err_t h_alive(httpd_req_t *r) { char b[96]; snprintf(b, sizeof b, "{\"self\":\"%s\",\"ips\":[\"%s\"]}", wifi_ip(), wifi_ip()); httpd_resp_set_type(r, "application/json"); httpd_resp_set_hdr(r, "Access-Control-Allow-Origin", "*"); return httpd_resp_send(r, b, -1); }
static esp_err_t h_info(httpd_req_t *r) {
    char nd[24], pd[24], ld[24], bs[24], be[24]; if (g_stratum.net_diff > 0) fmt_diff(g_stratum.net_diff, nd, sizeof nd); else strcpy(nd, "-"); fmt_diff(g_stratum.pool_diff, pd, sizeof pd); fmt_diff(g_stratum.last_share_diff, ld, sizeof ld); fmt_diff(g_stratum.best_session, bs, sizeof bs); fmt_diff(g_stratum.best_ever, be, sizeof be);
    char lr[96]; int k = 0; for (const char *q = g_stratum.last_reject; *q && k < 90; q++) if (*q != '"' && *q != '\\') lr[k++] = *q; lr[k] = 0;
    char b[1800];
    snprintf(b, sizeof b,
        "{\"identity\":{\"hwModel\":\"NMMiner\",\"hostName\":\"%s\",\"fwVersion\":\"%s\",\"rssi\":%d,\"displayName\":\"3BMiner\",\"board\":\"" CONFIG_BOARD_NAME "\",\"boardId\":\"" CONFIG_BOARD_ID "\",\"camera\":%s,\"mining\":%s},"
        "\"miner\":{\"hashRate\":%.6f,\"sAccepted\":%u,\"sRejected\":%u,\"uptimeSeconds\":%u,\"uptimeEver\":%u,\"networkDiff\":\"%s\",\"poolDiff\":\"%s\",\"lastDiff\":\"%s\",\"bestDiffSession\":\"%s\",\"bestDiffEver\":\"%s\",\"blkhits\":0,\"resetReason\":%d,\"freeHeap\":%u,\"minFreeHeap\":%u,\"freeInternal\":%u,\"kernelCycles\":%u,\"hashRateEngine\":%.6f,\"hashRateSw\":%.6f,\"candidates\":%u,\"totalHashes\":%llu},"
        "\"stratum\":{\"url\":\"%s\",\"user\":\"%s\",\"connected\":%s,\"jobs\":%u,\"submitted\":%u,\"candDropped\":%u,\"staleDropped\":%u,\"oldJobSubmits\":%u,\"rejStale\":%u,\"rejDup\":%u,\"rejLowDiff\":%u,\"rejOther\":%u,\"lastReject\":\"%s\"},\"temps\":{\"vcore\":null,\"asic\":null},\"storage\":{\"fsTotal\":0,\"fsUsed\":0}}",
        s_host, FW_VERSION, wifi_rssi(), CONFIG_BOARD_HAS_CAMERA_STR, g_cfg.mining ? "true" : "false", (g_miner.hashrate + g_miner.sw_hashrate) / 1e9, (unsigned)g_stratum.accepted, (unsigned)g_stratum.rejected, (unsigned)uptime_s(), (unsigned)uptime_s(), nd, pd, ld, bs, be, (int)esp_reset_reason(),
        (unsigned)esp_get_free_heap_size(), (unsigned)esp_get_minimum_free_heap_size(), (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL), (unsigned)g_miner.kernel_cycles, g_miner.hashrate / 1e9, g_miner.sw_hashrate / 1e9, (unsigned)g_miner.candidates, (unsigned long long)g_miner.total_hashes,
        g_stratum.pool_desc, g_stratum.user, g_stratum.connected ? "true" : "false", (unsigned)g_stratum.jobs, (unsigned)g_stratum.submitted,
        (unsigned)g_stratum.cand_dropped, (unsigned)g_stratum.stale_dropped, (unsigned)g_stratum.old_job_submits, (unsigned)g_stratum.rej_stale, (unsigned)g_stratum.rej_dup, (unsigned)g_stratum.rej_lowdiff, (unsigned)g_stratum.rej_other, lr);
    httpd_resp_set_type(r, "application/json"); httpd_resp_set_hdr(r, "Access-Control-Allow-Origin", "*"); return httpd_resp_send(r, b, -1);
}
static esp_err_t h_swbench(httpd_req_t *r) {   // GET /api/swbench: software sha256d cost on core 1
    uint32_t c = sw_bench_cycles(); char b[96]; snprintf(b, sizeof b, "{\"cyclesPerHash\":%u,\"khsOneCore\":%.1f}", (unsigned)c, 240000.0 / c);
    httpd_resp_set_type(r, "application/json"); return httpd_resp_send(r, b, -1);
}
static esp_err_t h_bench(httpd_req_t *r) {   // GET /api/bench?t=W1,W2,W3,L1,L2&n=NONCES[&apply=1]
    if (!g_cfg.mining) { httpd_resp_set_status(r, "409 Conflict"); return httpd_resp_send(r, "{\"error\":\"mining is off\"}", -1); }
    char q[128] = "", v[48]; httpd_req_get_url_query_str(r, q, sizeof q);
    uint32_t t[5]; for (int i = 0; i < 5; i++) t[i] = g_timing[i];
    if (httpd_query_key_value(q, "t", v, sizeof v) == ESP_OK) sscanf(v, "%u,%u,%u,%u,%u", (unsigned *)&t[0], (unsigned *)&t[1], (unsigned *)&t[2], (unsigned *)&t[3], (unsigned *)&t[4]);
    uint32_t k = g_kernel; if (httpd_query_key_value(q, "k", v, sizeof v) == ESP_OK) k = strtoul(v, NULL, 10);
    if (httpd_query_key_value(q, "sw", v, sizeof v) == ESP_OK) g_sw_enabled = strtoul(v, NULL, 10) != 0;
    uint32_t n = 262144; if (httpd_query_key_value(q, "n", v, sizeof v) == ESP_OK) n = strtoul(v, NULL, 10); if (n < 16384) n = 16384; if (n > 16777216) n = 16777216;
    for (int i = 0; i < 5; i++) if (t[i] > 200) t[i] = 200;
    memcpy(g_bench.t, t, sizeof t); g_bench.n = n; g_bench.k = k; g_bench.apply = httpd_query_key_value(q, "apply", v, sizeof v) == ESP_OK; g_bench.done = 0; g_bench.req = 1;
    for (int i = 0; i < 600 && !g_bench.done; i++) vTaskDelay(pdMS_TO_TICKS(100));
    char b[256]; snprintf(b, sizeof b, "{\"k\":%u,\"t\":[%u,%u,%u,%u,%u],\"n\":%u,\"done\":%s,\"cycPerNonce\":%.3f,\"hits\":%u,\"bad\":%u,\"sum\":\"%08x\",\"live\":[%u,%u,%u,%u,%u],\"liveKernel\":%u}",
        (unsigned)k, (unsigned)t[0], (unsigned)t[1], (unsigned)t[2], (unsigned)t[3], (unsigned)t[4], (unsigned)n, g_bench.done ? "true" : "false", g_bench.cyc_per_kn / 1000.0, (unsigned)g_bench.hits, (unsigned)g_bench.bad, (unsigned)g_bench.sum,
        (unsigned)g_timing[0], (unsigned)g_timing[1], (unsigned)g_timing[2], (unsigned)g_timing[3], (unsigned)g_timing[4], (unsigned)g_kernel);
    httpd_resp_set_type(r, "application/json"); httpd_resp_set_hdr(r, "Access-Control-Allow-Origin", "*"); return httpd_resp_send(r, b, -1);
}
static esp_err_t h_ok(httpd_req_t *r) { httpd_resp_set_type(r, "application/json"); httpd_resp_set_hdr(r, "Access-Control-Allow-Origin", "*"); return httpd_resp_send(r, "{\"status\":\"ok\"}", -1); }
static void restart_later(void *a) { vTaskDelay(pdMS_TO_TICKS(600)); esp_restart(); }
static esp_err_t h_restart(httpd_req_t *r) { h_ok(r); xTaskCreate(restart_later, "rst", 2048, NULL, 5, NULL); return ESP_OK; }
static esp_err_t h_config_get(httpd_req_t *r) {
    char b[400]; snprintf(b, sizeof b, "{\"ssid\":\"%s\",\"bssid\":\"%s\",\"pool\":\"%s\",\"port\":%u,\"wallet\":\"%s\",\"worker\":\"%s\",\"suggest\":%g,\"mining\":%s}", g_cfg.ssid, g_cfg.bssid, g_cfg.pool, g_cfg.port, g_cfg.wallet, g_cfg.worker, g_cfg.suggest, g_cfg.mining ? "true" : "false");
    httpd_resp_set_type(r, "application/json"); httpd_resp_set_hdr(r, "Access-Control-Allow-Origin", "*"); return httpd_resp_send(r, b, -1);
}
static esp_err_t h_config_post(httpd_req_t *r) {
    char buf[1024]; int n = httpd_req_recv(r, buf, sizeof buf - 1); if (n <= 0) return httpd_resp_send_500(r); buf[n] = 0;
    cJSON *j = cJSON_Parse(buf); if (!j) { httpd_resp_set_status(r, "400 Bad Request"); return httpd_resp_send(r, "bad json", -1); }
    cJSON *x;
    #define S(k, f) if ((x = cJSON_GetObjectItem(j, k)) && cJSON_IsString(x)) { strncpy(g_cfg.f, x->valuestring, sizeof g_cfg.f - 1); g_cfg.f[sizeof g_cfg.f - 1] = 0; }
    S("ssid", ssid) S("pass", pass) S("bssid", bssid) S("pool", pool) S("wallet", wallet) S("worker", worker)
    if ((x = cJSON_GetObjectItem(j, "port")) && cJSON_IsNumber(x)) g_cfg.port = x->valueint;
    if ((x = cJSON_GetObjectItem(j, "suggest")) && cJSON_IsNumber(x)) g_cfg.suggest = x->valuedouble;
    if ((x = cJSON_GetObjectItem(j, "mining")) && cJSON_IsBool(x)) g_cfg.mining = cJSON_IsTrue(x);
    cJSON_Delete(j); bool ok = config_save();
    httpd_resp_set_type(r, "application/json"); httpd_resp_set_hdr(r, "Access-Control-Allow-Origin", "*"); httpd_resp_send(r, ok ? "{\"status\":\"ok\",\"note\":\"restarting\"}" : "{\"status\":\"nvs error\"}", -1);
    if (ok) xTaskCreate(restart_later, "rst", 2048, NULL, 5, NULL);
    return ESP_OK;
}
// an image names its board as "3BMINER_BOARD=<id>;" (version.h); an upload naming another board is refused
static const char s_marker[] = FW_BOARD_MARKER;
static int marker_scan(const char *buf, int n, char *tail, int *tl) {   // 1 = ours, -1 = other board, 0 = not seen yet
    static const char key[] = "3BMINER_BOARD="; char w[96 + 4096]; int wl = *tl; memcpy(w, tail, wl); memcpy(w + wl, buf, n); wl += n;
    int res = 0;
    // only "key<id>;" with id = [a-z0-9_-]+ counts: the key itself also sits in this code as a bare string
    for (int i = 0; i + (int)sizeof key - 1 <= wl; i++) if (!memcmp(w + i, key, sizeof key - 1)) {
        int j = i + sizeof key - 1; while (j < wl && ((w[j] >= 'a' && w[j] <= 'z') || (w[j] >= '0' && w[j] <= '9') || w[j] == '_' || w[j] == '-')) j++;
        if (j == i + (int)sizeof key - 1 || j >= wl || w[j] != ';') continue;
        res = (j - i + 1 == (int)sizeof s_marker - 1 && !memcmp(w + i, s_marker, sizeof s_marker - 1)) ? 1 : -1; if (res < 0) break; }
    int keep = wl < 96 ? wl : 96; memcpy(tail, w + wl - keep, keep); *tl = keep; return res;
}
static esp_err_t h_update(httpd_req_t *r) {   // POST raw firmware image
    const esp_partition_t *part = esp_ota_get_next_update_partition(NULL); if (!part) return httpd_resp_send_500(r);
    camera_stop();   // no-op without a camera; on a camera board the image is written with the sensor off, a restart follows anyway
    esp_ota_handle_t h; if (esp_ota_begin(part, OTA_SIZE_UNKNOWN, &h) != ESP_OK) { camera_start(); return httpd_resp_send_500(r); }
    char *buf = malloc(4096); int remaining = r->content_len, total = 0; char tail[96]; int tl = 0, mk = 0;
    ESP_LOGI(TAG, "OTA start, %d bytes -> %s", remaining, part->label);
    while (remaining > 0) { int n = httpd_req_recv(r, buf, remaining > 4096 ? 4096 : remaining); if (n <= 0) { if (n == HTTPD_SOCK_ERR_TIMEOUT) continue; esp_ota_abort(h); free(buf); camera_start(); return httpd_resp_send_500(r); }
        if (mk == 0 || mk == 1) { int m = marker_scan(buf, n, tail, &tl); if (m) mk = m; }
        if (mk < 0) { esp_ota_abort(h); free(buf); camera_start(); httpd_resp_set_status(r, "409 Conflict"); httpd_resp_set_hdr(r, "Access-Control-Allow-Origin", "*"); return httpd_resp_send(r, "image is for another board (this is " CONFIG_BOARD_ID ")", -1); }
        if (esp_ota_write(h, buf, n) != ESP_OK) { esp_ota_abort(h); free(buf); camera_start(); httpd_resp_set_status(r, "500 Internal Server Error"); return httpd_resp_send(r, "ota write failed", -1); } remaining -= n; total += n; }
    free(buf);
    if (!mk) ESP_LOGW(TAG, "OTA image has no board marker (pre-0.6 build?), accepted");
    if (esp_ota_end(h) != ESP_OK || esp_ota_set_boot_partition(part) != ESP_OK) { camera_start(); httpd_resp_set_status(r, "500 Internal Server Error"); return httpd_resp_send(r, "ota end/validate failed", -1); }
    char b[96]; snprintf(b, sizeof b, "{\"status\":\"ok\",\"bytes\":%d,\"partition\":\"%s\",\"note\":\"restarting\"}", total, part->label);
    httpd_resp_set_type(r, "application/json"); httpd_resp_set_hdr(r, "Access-Control-Allow-Origin", "*"); httpd_resp_send(r, b, -1); xTaskCreate(restart_later, "rst", 2048, NULL, 5, NULL); return ESP_OK;
}
extern const uint8_t www_gz_start[] asm("_binary_index_html_gz_start"), www_gz_end[] asm("_binary_index_html_gz_end"),
    fav_gz_start[] asm("_binary_favicon_svg_gz_start"), fav_gz_end[] asm("_binary_favicon_svg_gz_end"),
    cam_gz_start[] asm("_binary_camera_html_gz_start"), cam_gz_end[] asm("_binary_camera_html_gz_end");   // main/www, tools/build_www.py
static esp_err_t h_root(httpd_req_t *r) { httpd_resp_set_type(r, "text/html"); httpd_resp_set_hdr(r, "Content-Encoding", "gzip"); httpd_resp_set_hdr(r, "Cache-Control", "max-age=300"); return httpd_resp_send(r, (const char *)www_gz_start, www_gz_end - www_gz_start); }
static esp_err_t h_favicon(httpd_req_t *r) { httpd_resp_set_type(r, "image/svg+xml"); httpd_resp_set_hdr(r, "Content-Encoding", "gzip"); httpd_resp_set_hdr(r, "Cache-Control", "max-age=86400"); return httpd_resp_send(r, (const char *)fav_gz_start, fav_gz_end - fav_gz_start); }
static esp_err_t h_campage(httpd_req_t *r) { httpd_resp_set_type(r, "text/html"); httpd_resp_set_hdr(r, "Content-Encoding", "gzip"); return httpd_resp_send(r, (const char *)cam_gz_start, cam_gz_end - cam_gz_start); }
void web_start(void) {
    uint8_t mac[6]; esp_read_mac(mac, ESP_MAC_WIFI_STA); snprintf(s_host, sizeof s_host, CONFIG_BOARD_HOST_PREFIX "-%02x%02x%02x", mac[3], mac[4], mac[5]);
    httpd_config_t c = HTTPD_DEFAULT_CONFIG(); c.core_id = 1; c.max_uri_handlers = 18 + camera_http_handler_count(); c.stack_size = 8192; c.lru_purge_enable = true; c.max_open_sockets = 5;   // 5 + 3 httpd internal + stratum stays well under LWIP_MAX_SOCKETS=16
    httpd_handle_t s; if (httpd_start(&s, &c) != ESP_OK) { ESP_LOGE(TAG, "httpd start failed"); return; }
    httpd_uri_t u[] = {
        { .uri = "/", .method = HTTP_GET, .handler = h_root }, { .uri = "/favicon.svg", .method = HTTP_GET, .handler = h_favicon }, { .uri = "/favicon.ico", .method = HTTP_GET, .handler = h_favicon }, { .uri = "/probe", .method = HTTP_GET, .handler = h_probe }, { .uri = "/alive", .method = HTTP_GET, .handler = h_alive },
        { .uri = "/api/system/info", .method = HTTP_GET, .handler = h_info }, { .uri = "/api/system/restart", .method = HTTP_POST, .handler = h_restart },
        { .uri = "/api/swarm/find", .method = HTTP_POST, .handler = h_ok }, { .uri = "/api/config", .method = HTTP_GET, .handler = h_config_get }, { .uri = "/api/config", .method = HTTP_POST, .handler = h_config_post },
        { .uri = "/api/bench", .method = HTTP_GET, .handler = h_bench }, { .uri = "/api/swbench", .method = HTTP_GET, .handler = h_swbench }, { .uri = "/update", .method = HTTP_POST, .handler = h_update } };
    for (unsigned i = 0; i < sizeof u / sizeof u[0]; i++) httpd_register_uri_handler(s, &u[i]);
    camera_register_http(s);
#ifdef CONFIG_BOARD_HAS_CAMERA
    const httpd_uri_t cp = { .uri = "/camera", .method = HTTP_GET, .handler = h_campage }; httpd_register_uri_handler(s, &cp);
#endif
}
