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
#define FW_VERSION "0.3.0"
static char s_host[32];
static void fmt_diff(double d, char *out, int n) { if (d >= 1e12) snprintf(out, n, "%.2fT", d / 1e12); else if (d >= 1e9) snprintf(out, n, "%.2fG", d / 1e9); else if (d >= 1e6) snprintf(out, n, "%.2fM", d / 1e6); else if (d >= 1e3) snprintf(out, n, "%.2fK", d / 1e3); else snprintf(out, n, "%.4g", d); }
static uint32_t uptime_s(void) { return (uint32_t)(esp_timer_get_time() / 1000000); }

static esp_err_t h_probe(httpd_req_t *r) {
    char b[320]; snprintf(b, sizeof b, "{\"model\":\"NMMiner\",\"hostname\":\"%s\",\"ver\":\"%s\",\"sw\":0,\"sh\":0,\"hr\":%.0f,\"sbd\":%.0f,\"ebd\":%.0f,\"ut\":%u}", s_host, FW_VERSION, g_miner.hashrate + g_miner.sw_hashrate, g_stratum.best_session, g_stratum.best_ever, (unsigned)uptime_s());
    httpd_resp_set_type(r, "application/json"); httpd_resp_set_hdr(r, "Access-Control-Allow-Origin", "*"); return httpd_resp_send(r, b, -1);
}
static esp_err_t h_alive(httpd_req_t *r) { char b[96]; snprintf(b, sizeof b, "{\"self\":\"%s\",\"ips\":[\"%s\"]}", wifi_ip(), wifi_ip()); httpd_resp_set_type(r, "application/json"); httpd_resp_set_hdr(r, "Access-Control-Allow-Origin", "*"); return httpd_resp_send(r, b, -1); }
static esp_err_t h_info(httpd_req_t *r) {
    char pd[24], ld[24], bs[24], be[24]; fmt_diff(g_stratum.pool_diff, pd, sizeof pd); fmt_diff(g_stratum.last_share_diff, ld, sizeof ld); fmt_diff(g_stratum.best_session, bs, sizeof bs); fmt_diff(g_stratum.best_ever, be, sizeof be);
    char lr[96]; int k = 0; for (const char *q = g_stratum.last_reject; *q && k < 90; q++) if (*q != '"' && *q != '\\') lr[k++] = *q; lr[k] = 0;
    char b[1800];
    snprintf(b, sizeof b,
        "{\"identity\":{\"hwModel\":\"NMMiner\",\"hostName\":\"%s\",\"fwVersion\":\"%s\",\"rssi\":%d,\"displayName\":\"ESP32 open fw\",\"board\":\"esp32-wroom-32\"},"
        "\"miner\":{\"hashRate\":%.6f,\"sAccepted\":%u,\"sRejected\":%u,\"uptimeSeconds\":%u,\"uptimeEver\":%u,\"networkDiff\":\"-\",\"poolDiff\":\"%s\",\"lastDiff\":\"%s\",\"bestDiffSession\":\"%s\",\"bestDiffEver\":\"%s\",\"blkhits\":0,\"freeHeap\":%u,\"minFreeHeap\":%u,\"kernelCycles\":%u,\"hashRateEngine\":%.6f,\"hashRateSw\":%.6f,\"candidates\":%u,\"totalHashes\":%llu},"
        "\"stratum\":{\"url\":\"%s\",\"user\":\"%s\",\"connected\":%s,\"jobs\":%u,\"submitted\":%u,\"candDropped\":%u,\"staleDropped\":%u,\"oldJobSubmits\":%u,\"rejStale\":%u,\"rejDup\":%u,\"rejLowDiff\":%u,\"rejOther\":%u,\"lastReject\":\"%s\"},\"temps\":{\"vcore\":null,\"asic\":null},\"storage\":{\"fsTotal\":0,\"fsUsed\":0}}",
        s_host, FW_VERSION, wifi_rssi(), (g_miner.hashrate + g_miner.sw_hashrate) / 1e9, (unsigned)g_stratum.accepted, (unsigned)g_stratum.rejected, (unsigned)uptime_s(), (unsigned)uptime_s(), pd, ld, bs, be,
        (unsigned)esp_get_free_heap_size(), (unsigned)esp_get_minimum_free_heap_size(), (unsigned)g_miner.kernel_cycles, g_miner.hashrate / 1e9, g_miner.sw_hashrate / 1e9, (unsigned)g_miner.candidates, (unsigned long long)g_miner.total_hashes,
        g_stratum.pool_desc, g_stratum.user, g_stratum.connected ? "true" : "false", (unsigned)g_stratum.jobs, (unsigned)g_stratum.submitted,
        (unsigned)g_stratum.cand_dropped, (unsigned)g_stratum.stale_dropped, (unsigned)g_stratum.old_job_submits, (unsigned)g_stratum.rej_stale, (unsigned)g_stratum.rej_dup, (unsigned)g_stratum.rej_lowdiff, (unsigned)g_stratum.rej_other, lr);
    httpd_resp_set_type(r, "application/json"); httpd_resp_set_hdr(r, "Access-Control-Allow-Origin", "*"); return httpd_resp_send(r, b, -1);
}
static esp_err_t h_ok(httpd_req_t *r) { httpd_resp_set_type(r, "application/json"); return httpd_resp_send(r, "{\"status\":\"ok\"}", -1); }
static void restart_later(void *a) { vTaskDelay(pdMS_TO_TICKS(600)); esp_restart(); }
static esp_err_t h_restart(httpd_req_t *r) { h_ok(r); xTaskCreate(restart_later, "rst", 2048, NULL, 5, NULL); return ESP_OK; }
static esp_err_t h_config_get(httpd_req_t *r) {
    char b[400]; snprintf(b, sizeof b, "{\"ssid\":\"%s\",\"bssid\":\"%s\",\"pool\":\"%s\",\"port\":%u,\"wallet\":\"%s\",\"worker\":\"%s\",\"suggest\":%g}", g_cfg.ssid, g_cfg.bssid, g_cfg.pool, g_cfg.port, g_cfg.wallet, g_cfg.worker, g_cfg.suggest);
    httpd_resp_set_type(r, "application/json"); return httpd_resp_send(r, b, -1);
}
static esp_err_t h_config_post(httpd_req_t *r) {
    char buf[1024]; int n = httpd_req_recv(r, buf, sizeof buf - 1); if (n <= 0) return httpd_resp_send_500(r); buf[n] = 0;
    cJSON *j = cJSON_Parse(buf); if (!j) { httpd_resp_set_status(r, "400 Bad Request"); return httpd_resp_send(r, "bad json", -1); }
    cJSON *x;
    #define S(k, f) if ((x = cJSON_GetObjectItem(j, k)) && cJSON_IsString(x)) { strncpy(g_cfg.f, x->valuestring, sizeof g_cfg.f - 1); g_cfg.f[sizeof g_cfg.f - 1] = 0; }
    S("ssid", ssid) S("pass", pass) S("bssid", bssid) S("pool", pool) S("wallet", wallet) S("worker", worker)
    if ((x = cJSON_GetObjectItem(j, "port")) && cJSON_IsNumber(x)) g_cfg.port = x->valueint;
    if ((x = cJSON_GetObjectItem(j, "suggest")) && cJSON_IsNumber(x)) g_cfg.suggest = x->valuedouble;
    cJSON_Delete(j); bool ok = config_save();
    httpd_resp_set_type(r, "application/json"); httpd_resp_send(r, ok ? "{\"status\":\"ok\",\"note\":\"restarting\"}" : "{\"status\":\"nvs error\"}", -1);
    if (ok) xTaskCreate(restart_later, "rst", 2048, NULL, 5, NULL);
    return ESP_OK;
}
static esp_err_t h_update(httpd_req_t *r) {   // POST raw firmware image
    const esp_partition_t *part = esp_ota_get_next_update_partition(NULL); if (!part) return httpd_resp_send_500(r);
    esp_ota_handle_t h; if (esp_ota_begin(part, OTA_SIZE_UNKNOWN, &h) != ESP_OK) return httpd_resp_send_500(r);
    char *buf = malloc(4096); int remaining = r->content_len, total = 0;
    ESP_LOGI(TAG, "OTA start, %d bytes -> %s", remaining, part->label);
    while (remaining > 0) { int n = httpd_req_recv(r, buf, remaining > 4096 ? 4096 : remaining); if (n <= 0) { if (n == HTTPD_SOCK_ERR_TIMEOUT) continue; esp_ota_abort(h); free(buf); return httpd_resp_send_500(r); }
        if (esp_ota_write(h, buf, n) != ESP_OK) { esp_ota_abort(h); free(buf); httpd_resp_set_status(r, "500 Internal Server Error"); return httpd_resp_send(r, "ota write failed", -1); } remaining -= n; total += n; }
    free(buf);
    if (esp_ota_end(h) != ESP_OK || esp_ota_set_boot_partition(part) != ESP_OK) { httpd_resp_set_status(r, "500 Internal Server Error"); return httpd_resp_send(r, "ota end/validate failed", -1); }
    char b[96]; snprintf(b, sizeof b, "{\"status\":\"ok\",\"bytes\":%d,\"partition\":\"%s\",\"note\":\"restarting\"}", total, part->label);
    httpd_resp_set_type(r, "application/json"); httpd_resp_send(r, b, -1); xTaskCreate(restart_later, "rst", 2048, NULL, 5, NULL); return ESP_OK;
}
static const char PAGE[] =
"<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>ESP32 Miner</title>"
"<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;margin:0;padding:16px}h1{font-weight:300;font-size:22px;margin:0 0 12px}"
".g{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.c{background:#1e1e1e;border:1px solid #333;border-radius:10px;padding:12px}"
".v{font-size:22px;margin-top:4px}.l{color:#999;font-size:12px}table{width:100%;border-collapse:collapse;margin-top:14px}td{padding:5px 0;border-bottom:1px solid #2a2a2a;font-size:14px}td:first-child{color:#999}"
"button{background:#2a2a2a;color:#eee;border:1px solid #444;border-radius:8px;padding:8px 12px;margin:10px 6px 0 0}</style></head><body>"
"<h1>ESP32 Miner <span id=host class=l></span></h1><div class=g>"
"<div class=c><div class=l>Hashrate</div><div class=v id=hr>-</div></div><div class=c><div class=l>Shares A/R</div><div class=v id=sh>-</div></div>"
"<div class=c><div class=l>Pool diff</div><div class=v id=pd>-</div></div><div class=c><div class=l>Best diff (session / ever)</div><div class=v id=bd>-</div></div></div>"
"<table><tr><td>Pool</td><td id=pool></td></tr><tr><td>User</td><td id=user></td></tr><tr><td>Jobs / submitted</td><td id=jobs></td></tr><tr><td>Kernel cycles per nonce</td><td id=kc></td></tr>"
"<tr><td>Uptime</td><td id=up></td></tr><tr><td>RSSI</td><td id=rssi></td></tr><tr><td>Free heap</td><td id=heap></td></tr><tr><td>Firmware</td><td id=fw></td></tr></table>"
"<button onclick=\"fetch('/api/system/restart',{method:'POST'})\">Restart</button><button onclick=\"location.href='/api/config'\">Config JSON</button>"
"<p class=l>OTA: <code>curl -X POST --data-binary @esp32miner.bin http://IP/update</code> &middot; config: <code>POST /api/config</code> JSON {ssid,pass,bssid,pool,port,wallet,worker,suggest}</p>"
"<script>function f(){fetch('/api/system/info').then(r=>r.json()).then(d=>{host.textContent=d.identity.hostName;hr.textContent=(d.miner.hashRate*1e6).toFixed(1)+' KH/s ('+(d.miner.hashRateEngine*1e6).toFixed(0)+' engine + '+(d.miner.hashRateSw*1e6).toFixed(0)+' sw)';sh.textContent=d.miner.sAccepted+' / '+d.miner.sRejected;"
"pd.textContent=d.miner.poolDiff;bd.textContent=d.miner.bestDiffSession+' / '+d.miner.bestDiffEver;pool.textContent=d.stratum.url+(d.stratum.connected?' (connected)':' (disconnected)');user.textContent=d.stratum.user;"
"jobs.textContent=d.stratum.jobs+' / '+d.stratum.submitted;kc.textContent=d.miner.kernelCycles;up.textContent=Math.floor(d.miner.uptimeSeconds/3600)+'h '+Math.floor(d.miner.uptimeSeconds%3600/60)+'m';rssi.textContent=d.identity.rssi+' dBm';heap.textContent=d.miner.freeHeap;fw.textContent=d.identity.fwVersion}).catch(()=>{})}f();setInterval(f,2000)</script></body></html>";
static esp_err_t h_root(httpd_req_t *r) { httpd_resp_set_type(r, "text/html"); return httpd_resp_send(r, PAGE, -1); }
void web_start(void) {
    uint8_t mac[6]; esp_read_mac(mac, ESP_MAC_WIFI_STA); snprintf(s_host, sizeof s_host, "ESP32Miner-%02x%02x%02x", mac[3], mac[4], mac[5]);
    httpd_config_t c = HTTPD_DEFAULT_CONFIG(); c.core_id = 1; c.max_uri_handlers = 12; c.stack_size = 8192; c.lru_purge_enable = true;
    httpd_handle_t s; if (httpd_start(&s, &c) != ESP_OK) { ESP_LOGE(TAG, "httpd start failed"); return; }
    httpd_uri_t u[] = {
        { .uri = "/", .method = HTTP_GET, .handler = h_root }, { .uri = "/probe", .method = HTTP_GET, .handler = h_probe }, { .uri = "/alive", .method = HTTP_GET, .handler = h_alive },
        { .uri = "/api/system/info", .method = HTTP_GET, .handler = h_info }, { .uri = "/api/system/restart", .method = HTTP_POST, .handler = h_restart },
        { .uri = "/api/swarm/find", .method = HTTP_POST, .handler = h_ok }, { .uri = "/api/config", .method = HTTP_GET, .handler = h_config_get }, { .uri = "/api/config", .method = HTTP_POST, .handler = h_config_post },
        { .uri = "/update", .method = HTTP_POST, .handler = h_update } };
    for (unsigned i = 0; i < sizeof u / sizeof u[0]; i++) httpd_register_uri_handler(s, &u[i]);
}
