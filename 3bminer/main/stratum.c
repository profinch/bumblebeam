#include "stratum.h"
#include "version.h"
#include "addr.h"
#include "config.h"
#include "wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/queue.h"
#include "freertos/idf_additions.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "cJSON.h"
#include "lwip/sockets.h"
#include "lwip/netdb.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
static const char *TAG = "stratum";
stratum_stats_t g_stratum;
static job_t s_job; static session_t s_sess; static SemaphoreHandle_t s_lock; static QueueHandle_t s_cands;
static int s_sock = -1; static uint32_t s_id = 10; static char s_rx[12288]; static int s_rxlen = 0;
static uint32_t s_pending_submit_ids[64]; static int s_npend = 0;
static uint8_t s_prog[40]; static int s_plen = 0;   // the payout address as it appears in an output script
// recent jobs still valid for submits: a non-clean notify keeps the older ones acceptable to the pool
typedef struct { uint32_t seq; char job_id[64]; char ntime_hex[9]; } recent_job_t;
#define NRECENT 4
static recent_job_t s_recent[NRECENT]; static int s_nrecent = 0; static uint32_t s_seqctr = 0;

static bool s_reconnect = false;   // client.reconnect from the pool
// a string member of a pool message, "" when it is missing or not a string (a NULL valuestring would crash the parsers)
static const char *jstr(const cJSON *a, int i) { const cJSON *x = cJSON_GetArrayItem(a, i); return cJSON_IsString(x) && x->valuestring ? x->valuestring : ""; }
// extranonce1 up to 16 bytes, extranonce2 1..8: anything else would overrun the coinbase and submit buffers
static bool set_session(const char *en1, const cJSON *en2) {
    uint8_t b[16]; int l = hex2bin(en1, b, sizeof b); int sz = cJSON_IsNumber(en2) ? en2->valueint : 0;
    if (l < 0 || sz < 1 || sz > 8) { ESP_LOGW(TAG, "bad extranonce (en1 %d bytes, en2 size %d)", l, sz); return false; }
    xSemaphoreTake(s_lock, portMAX_DELAY); memcpy(s_sess.extranonce1, b, l); s_sess.en1_len = l; s_sess.en2_size = sz; s_nrecent = 0; xSemaphoreGive(s_lock); return true;
}
static int send_line(const char *s) { if (s_sock < 0) return -1; int n = strlen(s); return send(s_sock, s, n, 0) == n ? 0 : -1; }
static bool get_job(job_t *dst, session_t *s, uint32_t *seq) {
    bool r = false; xSemaphoreTake(s_lock, portMAX_DELAY);
    if (s_job.seq != *seq && s_job.seq != 0 && s_sess.en2_size) { memcpy(dst, &s_job, sizeof s_job); memcpy(s, &s_sess, sizeof s_sess); *seq = s_job.seq; r = true; }
    xSemaphoreGive(s_lock); return r;
}
bool stratum_get_job(job_t *dst, session_t *s, uint32_t *seq) { return get_job(dst, s, seq); }
void stratum_submit_candidate(const candidate_t *c) { if (xQueueSend(s_cands, c, 0) != pdTRUE) g_stratum.cand_dropped++; }

static void handle_notify(cJSON *p) {
    if (!cJSON_IsArray(p) || cJSON_GetArraySize(p) < 9) return;
    job_t j; memset(&j, 0, sizeof j);
    strncpy(j.job_id, jstr(p, 0), sizeof j.job_id - 1);
    const char *ph = jstr(p, 1), *nt = jstr(p, 7); if (strlen(ph) != 64 || strlen(nt) != 8 || !j.job_id[0]) { ESP_LOGW(TAG, "bad notify"); return; }
    for (int i = 0; i < 8; i++) { char t[9]; memcpy(t, ph + 8 * i, 8); t[8] = 0; j.prevhash_w[i] = __builtin_bswap32(strtoul(t, NULL, 16)); }
    j.coinb1_len = hex2bin(jstr(p, 2), j.coinb1, sizeof j.coinb1);
    j.coinb2_len = hex2bin(jstr(p, 3), j.coinb2, sizeof j.coinb2);
    if (j.coinb1_len < 0 || j.coinb2_len < 0) { ESP_LOGW(TAG, "coinbase does not fit (%u + %u hex chars)", (unsigned)strlen(jstr(p, 2)), (unsigned)strlen(jstr(p, 3))); return; }
    cJSON *br = cJSON_GetArrayItem(p, 4); j.nbranch = 0;
    if (cJSON_IsArray(br)) { int n = cJSON_GetArraySize(br); if (n > MAX_BRANCH) { ESP_LOGW(TAG, "too many branches %d", n); return; } for (int i = 0; i < n; i++) { if (hex2bin(jstr(br, i), j.branch[i], 32) != 32) return; j.nbranch++; } }
    j.version = strtoul(jstr(p, 5), NULL, 16);
    j.nbits = strtoul(jstr(p, 6), NULL, 16);
    memcpy(j.ntime_hex, nt, 8); j.ntime = strtoul(j.ntime_hex, NULL, 16);
    j.clean = cJSON_IsTrue(cJSON_GetArrayItem(p, 8));
    { int ex = j.nbits >> 24; double mant = j.nbits & 0xffffff; if (mant > 0) g_stratum.net_diff = 65535.0 * ldexp(1.0, 208) / (mant * ldexp(1.0, 8 * (ex - 3))); }   // network difficulty from nbits
    g_stratum.solo = (addr_in(j.coinb1, j.coinb1_len, s_prog, s_plen) || addr_in(j.coinb2, j.coinb2_len, s_prog, s_plen)) ? 1 : 0;
    xSemaphoreTake(s_lock, portMAX_DELAY); j.seq = ++s_seqctr; memcpy(&s_job, &j, sizeof j);
    if (j.clean) s_nrecent = 0;
    memmove(&s_recent[1], &s_recent[0], sizeof(recent_job_t) * (NRECENT - 1)); if (s_nrecent < NRECENT) s_nrecent++;
    s_recent[0].seq = j.seq; memcpy(s_recent[0].job_id, j.job_id, sizeof j.job_id); memcpy(s_recent[0].ntime_hex, j.ntime_hex, sizeof j.ntime_hex);
    xSemaphoreGive(s_lock);
    g_stratum.jobs++; g_stratum.last_job_us = esp_timer_get_time();
    ESP_LOGI(TAG, "job %s clean=%d branches=%d ntime=%s", j.job_id, j.clean, j.nbranch, j.ntime_hex);
}
static void handle_line(char *line) {
    cJSON *m = cJSON_Parse(line); if (!m) { ESP_LOGW(TAG, "bad json: %.80s", line); return; }
    cJSON *method = cJSON_GetObjectItem(m, "method"); cJSON *id = cJSON_GetObjectItem(m, "id"); cJSON *res = cJSON_GetObjectItem(m, "result"); cJSON *err = cJSON_GetObjectItem(m, "error");
    if (method && cJSON_IsString(method)) {
        cJSON *p = cJSON_GetObjectItem(m, "params");
        if (!strcmp(method->valuestring, "mining.notify")) handle_notify(p);
        else if (!strcmp(method->valuestring, "mining.set_difficulty")) { cJSON *d = cJSON_GetArrayItem(p, 0); if (cJSON_IsNumber(d) && d->valuedouble > 0 && isfinite(d->valuedouble)) { g_stratum.pool_diff = d->valuedouble; ESP_LOGI(TAG, "pool diff %g", g_stratum.pool_diff); } }
        else if (!strcmp(method->valuestring, "mining.set_extranonce")) { if (cJSON_IsArray(p)) set_session(jstr(p, 0), cJSON_GetArrayItem(p, 1)); }
        else if (!strcmp(method->valuestring, "client.reconnect")) { ESP_LOGW(TAG, "reconnect requested"); s_reconnect = true; }   // to the configured pool: a host in the params is not followed
    } else if (id && cJSON_IsNumber(id)) {
        int rid = id->valueint;
        if (rid == 1) {   // subscribe
            if (cJSON_IsArray(res) && set_session(jstr(res, 1), cJSON_GetArrayItem(res, 2))) ESP_LOGI(TAG, "subscribed en1_len=%d en2_size=%d", s_sess.en1_len, s_sess.en2_size);
            else { ESP_LOGW(TAG, "subscribe failed: %.120s", line); s_reconnect = true; }
        } else if (rid == 2) { g_stratum.authorized = cJSON_IsTrue(res) ? 1 : 0; ESP_LOGI(TAG, "authorize: %s", g_stratum.authorized ? "ok" : "FAILED"); }
        else if (rid == 3) { /* suggest_difficulty */ }
        else {
            bool pend = false; for (int i = 0; i < s_npend; i++) if (s_pending_submit_ids[i] == (uint32_t)rid) { pend = true; s_pending_submit_ids[i] = s_pending_submit_ids[--s_npend]; break; }
            if (pend) { if (cJSON_IsTrue(res)) { g_stratum.accepted++; g_stratum.share_us = esp_timer_get_time(); ESP_LOGI(TAG, "share ACCEPTED (%u/%u)", (unsigned)g_stratum.accepted, (unsigned)g_stratum.rejected); } else { g_stratum.rejected++; ESP_LOGW(TAG, "share REJECTED: %.160s", line);
                char *e = err ? cJSON_PrintUnformatted(err) : NULL; snprintf((char *)g_stratum.last_reject, sizeof g_stratum.last_reject, "%s", e ? e : "?"); free(e);
                // stratum error codes: 21 job not found (stale), 22 duplicate share, 23 low difficulty; fall back to the message text
                cJSON *ec = cJSON_IsArray(err) ? cJSON_GetArrayItem(err, 0) : NULL; int code = cJSON_IsNumber(ec) ? ec->valueint : 0; const char *lr = (const char *)g_stratum.last_reject;
                if (code == 21 || strstr(lr, "tale") || strstr(lr, "not found")) g_stratum.rej_stale++;
                else if (code == 22 || strstr(lr, "uplicate")) g_stratum.rej_dup++;
                else if (code == 23 || strstr(lr, "ifficult") || strstr(lr, "low")) g_stratum.rej_lowdiff++;
                else g_stratum.rej_other++; } }
        }
    }
    (void)err; cJSON_Delete(m);
}
static void do_submits(void) {
    candidate_t c;
    while (xQueueReceive(s_cands, &c, 0) == pdTRUE) {
        uint32_t H[8]; job_hash(c.w, c.nonce_word, H); double d = job_diff(H);
        if (d > g_stratum.best_session) g_stratum.best_session = d;
        if (d > g_stratum.best_ever) g_stratum.best_ever = d;
        if (H[7] == 0) ESP_LOGW(TAG, "*** diff-1+ hash found: %08x%08x... diff %.3f", (unsigned)__builtin_bswap32(H[7]), (unsigned)__builtin_bswap32(H[6]), d);
        if (d + 1e-12 < g_stratum.pool_diff) continue;   // below pool target: not a share
        recent_job_t cur; session_t ss; bool have = false;
        xSemaphoreTake(s_lock, portMAX_DELAY);
        for (int i = 0; i < s_nrecent; i++) if (s_recent[i].seq == c.job_seq) { cur = s_recent[i]; memcpy(&ss, &s_sess, sizeof ss); have = true; if (i) g_stratum.old_job_submits++; break; }
        xSemaphoreGive(s_lock);
        if (!have) { g_stratum.stale_dropped++; ESP_LOGW(TAG, "stale candidate, job changed"); continue; }
        char en2hex[17]; uint8_t en2b[8]; for (int i = 0; i < ss.en2_size; i++) en2b[i] = (i < 4) ? (c.en2 >> (8 * i)) & 0xff : 0; bin2hex(en2b, ss.en2_size, en2hex);
        uint32_t nonce = __builtin_bswap32(c.nonce_word);
        char line[512]; uint32_t id = ++s_id;
        snprintf(line, sizeof line, "{\"id\":%u,\"method\":\"mining.submit\",\"params\":[\"%s\",\"%s\",\"%s\",\"%s\",\"%08x\"]}\n", (unsigned)id, g_stratum.user, cur.job_id, en2hex, cur.ntime_hex, (unsigned)nonce);
        if (send_line(line) == 0) { g_stratum.submitted++; g_stratum.last_share_diff = d; if (s_npend < 64) s_pending_submit_ids[s_npend++] = id; ESP_LOGI(TAG, "submit nonce %08x diff %.4f (pool %.4f)", (unsigned)nonce, d, g_stratum.pool_diff); }
    }
}
static void task(void *arg) {
    for (;;) {
        while (!wifi_connected()) vTaskDelay(pdMS_TO_TICKS(500));
        struct addrinfo hints = { .ai_family = AF_INET, .ai_socktype = SOCK_STREAM }, *ai = NULL; char ports[8]; snprintf(ports, sizeof ports, "%u", g_cfg.port);
        if (getaddrinfo(g_cfg.pool, ports, &hints, &ai) != 0 || !ai) { ESP_LOGW(TAG, "dns fail %s", g_cfg.pool); vTaskDelay(pdMS_TO_TICKS(5000)); continue; }
        s_sock = socket(AF_INET, SOCK_STREAM, 0); if (s_sock < 0) { ESP_LOGW(TAG, "no socket"); freeaddrinfo(ai); vTaskDelay(pdMS_TO_TICKS(5000)); continue; }
        struct timeval tv = { .tv_sec = 0, .tv_usec = 20000 };   /* short poll: submit candidates within ~20 ms */ setsockopt(s_sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv); int one = 1; setsockopt(s_sock, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
        struct timeval stv = { .tv_sec = 10 }; setsockopt(s_sock, SOL_SOCKET, SO_SNDTIMEO, &stv, sizeof stv);   // a stalled pool must not hang the task in send()
        setsockopt(s_sock, SOL_SOCKET, SO_KEEPALIVE, &one, sizeof one); int ki = 60, kc = 3; setsockopt(s_sock, IPPROTO_TCP, TCP_KEEPIDLE, &ki, sizeof ki); setsockopt(s_sock, IPPROTO_TCP, TCP_KEEPINTVL, &ki, sizeof ki); setsockopt(s_sock, IPPROTO_TCP, TCP_KEEPCNT, &kc, sizeof kc);
        if (connect(s_sock, ai->ai_addr, ai->ai_addrlen) != 0) { ESP_LOGW(TAG, "connect fail"); close(s_sock); s_sock = -1; freeaddrinfo(ai); vTaskDelay(pdMS_TO_TICKS(5000)); continue; }
        freeaddrinfo(ai);
        snprintf(g_stratum.pool_desc, sizeof g_stratum.pool_desc, "%s:%u", g_cfg.pool, g_cfg.port);
        snprintf(g_stratum.user, sizeof g_stratum.user, "%s%s%s", g_cfg.wallet, g_cfg.worker[0] ? "." : "", g_cfg.worker);
        ESP_LOGI(TAG, "connected to %s", g_stratum.pool_desc);
        xSemaphoreTake(s_lock, portMAX_DELAY); s_sess.en2_size = 0; xSemaphoreGive(s_lock); s_reconnect = false; g_stratum.authorized = -1;   // no mining until this session's subscribe answer
        char line[300];
        snprintf(line, sizeof line, "{\"id\":1,\"method\":\"mining.subscribe\",\"params\":[\"3BMiner/" FW_VERSION "\"]}\n"); send_line(line);
        snprintf(line, sizeof line, "{\"id\":2,\"method\":\"mining.authorize\",\"params\":[\"%s\",\"x\"]}\n", g_stratum.user); send_line(line);
        snprintf(line, sizeof line, "{\"id\":3,\"method\":\"mining.suggest_difficulty\",\"params\":[%g]}\n", g_cfg.suggest); send_line(line);
        g_stratum.connect_us = esp_timer_get_time(); g_stratum.connected = true; s_rxlen = 0; s_npend = 0; int64_t last_rx = esp_timer_get_time();
        for (;;) {
            int n = recv(s_sock, s_rx + s_rxlen, sizeof s_rx - 1 - s_rxlen, 0);
            if (n > 0) { s_rxlen += n; s_rx[s_rxlen] = 0; last_rx = esp_timer_get_time();
                char *start = s_rx, *nl;
                while ((nl = strchr(start, '\n'))) { *nl = 0; handle_line(start); start = nl + 1; }
                int rem = s_rxlen - (start - s_rx); memmove(s_rx, start, rem); s_rxlen = rem;
                if (s_rxlen >= (int)sizeof s_rx - 1) { ESP_LOGW(TAG, "line too long, dropping"); s_rxlen = 0; }
            } else if (n == 0) { ESP_LOGW(TAG, "pool closed"); break; }
            else if (errno != EWOULDBLOCK && errno != EAGAIN) { ESP_LOGW(TAG, "recv error %d", errno); break; }
            do_submits();
            if (esp_timer_get_time() - last_rx > 600LL * 1000000) { ESP_LOGW(TAG, "no data 10 min, reconnect"); break; }
            if (!wifi_connected() || s_reconnect) break;
        }
        g_stratum.connected = false; close(s_sock); s_sock = -1;
        xSemaphoreTake(s_lock, portMAX_DELAY); s_job.seq = 0; s_nrecent = 0; xSemaphoreGive(s_lock);
        vTaskDelay(pdMS_TO_TICKS(3000));
    }
}
void stratum_start(void) {
    s_lock = xSemaphoreCreateMutex(); s_cands = xQueueCreate(32, sizeof(candidate_t)); g_stratum.pool_diff = 1.0; g_stratum.solo = -1;
    s_plen = addr_program(g_cfg.wallet, s_prog); if (!s_plen) ESP_LOGW(TAG, "payout address does not parse: solo detection off");
#ifdef CONFIG_SPIRAM
    // PSRAM boards: the camera's DMA buffers leave little internal RAM, and this task never touches flash, so its stack can live in PSRAM
    xTaskCreatePinnedToCoreWithCaps(task, "stratum", 24576, NULL, 5, NULL, 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
#else
    xTaskCreatePinnedToCore(task, "stratum", 24576, NULL, 5, NULL, 1);
#endif
}
