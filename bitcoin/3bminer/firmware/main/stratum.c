#include "stratum.h"
#include "version.h"
#include "addr.h"
#include "config.h"
#include "wifi.h"
#include "netcheck.h"
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
static uint8_t s_spk[ADDR_SCRIPT_MAX]; static int s_spklen = 0;   // the output script that pays the configured address
// recent jobs: a non-clean notify keeps the older ones acceptable to the pool. A clean one (or a new session) marks them
// replaced instead of dropping them: a share for a replaced job is stale, but a hash that is a whole block is still
// submitted - the pool decides, and a template refresh sent as clean (same previous block) would otherwise lose it
typedef struct { uint32_t seq; char job_id[sizeof ((job_t *)0)->job_id]; char ntime_hex[9]; uint32_t prev[8]; bool replaced; } recent_job_t;
#define NRECENT 8
static recent_job_t s_recent[NRECENT]; static int s_nrecent = 0; static uint32_t s_seqctr = 0;
static void replace_recent(void) { for (int i = 0; i < s_nrecent; i++) s_recent[i].replaced = true; }   // under s_lock

static bool s_reconnect = false;   // client.reconnect from the pool
// doubles are two words on the ESP32: read and written under a spinlock, so another core never sees half of one
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
void stratum_set_pool_diff(double d) { portENTER_CRITICAL(&s_mux); g_stratum.pool_diff = d; portEXIT_CRITICAL(&s_mux); }
double stratum_pool_diff(void) { portENTER_CRITICAL(&s_mux); double d = g_stratum.pool_diff; portEXIT_CRITICAL(&s_mux); return d; }
void stratum_best(double d) { portENTER_CRITICAL(&s_mux); if (d > g_stratum.best_session) g_stratum.best_session = d; if (d > g_stratum.best_ever) g_stratum.best_ever = d; portEXIT_CRITICAL(&s_mux); }
double stratum_best_ever(void) { portENTER_CRITICAL(&s_mux); double d = g_stratum.best_ever; portEXIT_CRITICAL(&s_mux); return d; }
// a string member of a pool message, "" when it is missing or not a string (a NULL valuestring would crash the parsers)
static const char *jstr(const cJSON *a, int i) { const cJSON *x = cJSON_GetArrayItem(a, i); return cJSON_IsString(x) && x->valuestring ? x->valuestring : ""; }
// extranonce1 up to 16 bytes, extranonce2 1..8: anything else would overrun the coinbase and submit buffers
static bool set_session(const char *en1, const cJSON *en2) {
    uint8_t b[16]; int l = hex2bin(en1, b, sizeof b); int sz = cJSON_IsNumber(en2) ? en2->valueint : 0;
    if (l < 0 || sz < 1 || sz > 8) { ESP_LOGW(TAG, "bad extranonce (en1 %d bytes, en2 size %d)", l, sz); return false; }
    // new extranonces: the job the miners hold was built with the old ones, so they wait for the next notify
    xSemaphoreTake(s_lock, portMAX_DELAY); memcpy(s_sess.extranonce1, b, l); s_sess.en1_len = l; s_sess.en2_size = sz; s_job.seq = 0; replace_recent(); xSemaphoreGive(s_lock); return true;
}
// a line half sent leaves the stream broken for every later one: any failure ends the connection
static int send_line(const char *s) { if (s_sock < 0) return -1; int n = strlen(s); if (send(s_sock, s, n, 0) == n) return 0; ESP_LOGW(TAG, "send failed, reconnect"); s_reconnect = true; return -1; }
static bool get_job(job_t *dst, session_t *s, uint32_t *seq) {
    bool r = false; xSemaphoreTake(s_lock, portMAX_DELAY);
    if (s_job.seq != *seq && s_job.seq != 0 && s_sess.en2_size) { memcpy(dst, &s_job, sizeof s_job); memcpy(s, &s_sess, sizeof s_sess); *seq = s_job.seq; r = true; }
    xSemaphoreGive(s_lock); return r;
}
bool stratum_get_job(job_t *dst, session_t *s, uint32_t *seq) { return get_job(dst, s, seq); }
bool stratum_job_live(uint32_t seq) { return seq && s_job.seq == seq; }   // one aligned word: no lock needed
// accepted shares per minute of uptime, the last 60 minutes: s_bmin[i] is the minute bucket i holds
static double s_bdiff[60]; static uint32_t s_bn[60], s_bmin[60] = { [0 ... 59] = UINT32_MAX };
static void share_count(double diff) {
    uint32_t m = (uint32_t)(esp_timer_get_time() / 60000000), i = m % 60;
    if (s_bmin[i] != m) { s_bmin[i] = m; s_bdiff[i] = 0; s_bn[i] = 0; }
    s_bdiff[i] += diff; s_bn[i]++;
}
double stratum_share_hps(uint32_t *n, uint32_t *secs) {
    int64_t now = esp_timer_get_time(); uint32_t m = (uint32_t)(now / 60000000); double d = 0; *n = 0;
    for (int i = 0; i < 60; i++) if (s_bmin[i] != UINT32_MAX && s_bmin[i] + 59 >= m && s_bmin[i] <= m) { d += s_bdiff[i]; *n += s_bn[i]; }
    int64_t from = (int64_t)(m >= 59 ? m - 59 : 0) * 60000000; *secs = (uint32_t)((now - from) / 1000000);
    return *secs ? d * 4294967296.0 / *secs : 0;
}
void stratum_submit_candidate(const candidate_t *c) { if (xQueueSend(s_cands, c, 0) != pdTRUE) g_stratum.cand_dropped++; }

// exactly n hex digits into a number; false for anything else
static bool hexword(const char *h, int n, uint32_t *v) { if ((int)strlen(h) != n) return false; uint8_t b[4]; if (hex2bin(h, b, 4) != n / 2) return false; *v = 0; for (int i = 0; i < n / 2; i++) *v = *v << 8 | b[i]; return true; }
// a job id goes back into submits as it is: printable, no quotes or backslashes
static bool plain_id(const char *s) { if (!*s) return false; for (; *s; s++) if (*s == '"' || *s == '\\' || (unsigned char)*s < 32) return false; return true; }
static job_t s_nj;   // the notify being parsed (6.5 KB: off the task stack)
static void handle_notify(cJSON *p) {
    job_t *j = &s_nj; memset(j, 0, sizeof *j); const char *why = NULL;
    if (!cJSON_IsArray(p) || cJSON_GetArraySize(p) < 9) why = "short";
    const char *id = why ? "" : jstr(p, 0), *ph = why ? "" : jstr(p, 1);
    if (!why && (strlen(id) >= sizeof j->job_id || !plain_id(id))) why = "job id";
    if (!why) { strcpy(j->job_id, id); if (strlen(ph) != 64) why = "prevhash";
        for (int i = 0; i < 8 && !why; i++) { char t[9]; memcpy(t, ph + 8 * i, 8); t[8] = 0; uint32_t v; if (!hexword(t, 8, &v)) why = "prevhash"; else j->prevhash_w[i] = __builtin_bswap32(v); } }
    if (!why && (!hexword(jstr(p, 5), 8, &j->version) || !hexword(jstr(p, 6), 8, &j->nbits) || !hexword(jstr(p, 7), 8, &j->ntime))) why = "version, nbits or ntime";
    if (!why) { j->coinb1_len = hex2bin(jstr(p, 2), j->coinb1, sizeof j->coinb1); j->coinb2_len = hex2bin(jstr(p, 3), j->coinb2, sizeof j->coinb2); if (j->coinb1_len < 0 || j->coinb2_len < 0) why = "coinbase too long or not hex"; }
    cJSON *br = why ? NULL : cJSON_GetArrayItem(p, 4);
    if (!why && cJSON_IsArray(br)) { int n = cJSON_GetArraySize(br); if (n > MAX_BRANCH) why = "too many branches"; for (int i = 0; i < n && !why; i++) { if (hex2bin(jstr(br, i), j->branch[i], 32) != 32) why = "branch"; else j->nbranch++; } }
    j->clean = !why && cJSON_IsTrue(cJSON_GetArrayItem(p, 8));
    if (why) {
        // a job that cannot be mined: if it was meant to replace the others (clean), they are dead too, so stop rather than
        // hash a previous block until the next notify
        bool clean = cJSON_IsArray(p) && cJSON_IsTrue(cJSON_GetArrayItem(p, 8));
        ESP_LOGW(TAG, "notify refused (%s)%s", why, clean ? ", mining paused until the next job" : "");
        if (clean) { xSemaphoreTake(s_lock, portMAX_DELAY); s_job.seq = 0; replace_recent(); xSemaphoreGive(s_lock); }
        return;
    }
    snprintf(j->ntime_hex, sizeof j->ntime_hex, "%08x", (unsigned)j->ntime);
    { int ex = j->nbits >> 24; double mant = j->nbits & 0xffffff; if (mant > 0) g_stratum.net_diff = 65535.0 * ldexp(1.0, 208) / (mant * ldexp(1.0, 8 * (ex - 3))); }   // network difficulty from nbits
    // solo: the coinbase's outputs pay (nearly) all of the reward to the configured address; the extranonces sit inside the
    // input script, so zeros of their length do for parsing
    if (s_spklen) { static uint8_t cb[sizeof j->coinb1 + 24 + sizeof j->coinb2]; size_t n = 0; memcpy(cb, j->coinb1, j->coinb1_len); n += j->coinb1_len;
        int en = s_sess.en1_len + s_sess.en2_size; memset(cb + n, 0, en); n += en; memcpy(cb + n, j->coinb2, j->coinb2_len); n += j->coinb2_len;
        int pc = addr_coinbase_share(cb, n, s_spk, s_spklen); g_stratum.solo = pc < 0 ? -1 : pc >= 95; }
    xSemaphoreTake(s_lock, portMAX_DELAY); j->seq = ++s_seqctr; memcpy(&s_job, j, sizeof *j);
    if (j->clean) replace_recent();
    memmove(&s_recent[1], &s_recent[0], sizeof(recent_job_t) * (NRECENT - 1)); if (s_nrecent < NRECENT) s_nrecent++;
    recent_job_t *rj = &s_recent[0]; rj->seq = j->seq; strcpy(rj->job_id, j->job_id); memcpy(rj->ntime_hex, j->ntime_hex, sizeof rj->ntime_hex); memcpy(rj->prev, j->prevhash_w, sizeof rj->prev); rj->replaced = false;
    xSemaphoreGive(s_lock);
    g_stratum.jobs++; g_stratum.last_job_us = esp_timer_get_time();
    ESP_LOGI(TAG, "job %s clean=%d branches=%d ntime=%s", j->job_id, j->clean, j->nbranch, j->ntime_hex);
}
static void handle_line(char *line) {
    // a pool line nests 3 levels (notify params, branches); a deep one would overflow this task's stack inside cJSON
    cJSON *m = net_json_depth_ok(line, 6) ? cJSON_Parse(line) : NULL; if (!m) { ESP_LOGW(TAG, "bad json: %.80s", line); return; }
    cJSON *method = cJSON_GetObjectItem(m, "method"); cJSON *id = cJSON_GetObjectItem(m, "id"); cJSON *res = cJSON_GetObjectItem(m, "result"); cJSON *err = cJSON_GetObjectItem(m, "error");
    if (method && cJSON_IsString(method)) {
        cJSON *p = cJSON_GetObjectItem(m, "params");
        if (!strcmp(method->valuestring, "mining.notify")) handle_notify(p);
        else if (!strcmp(method->valuestring, "mining.set_difficulty")) { cJSON *d = cJSON_GetArrayItem(p, 0); if (cJSON_IsNumber(d) && d->valuedouble > 0 && isfinite(d->valuedouble)) { stratum_set_pool_diff(d->valuedouble); ESP_LOGI(TAG, "pool diff %g", d->valuedouble); } }
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
            if (pend) { if (cJSON_IsTrue(res)) { g_stratum.accepted++; g_stratum.share_us = esp_timer_get_time(); share_count(stratum_pool_diff()); ESP_LOGI(TAG, "share ACCEPTED (%u/%u)", (unsigned)g_stratum.accepted, (unsigned)g_stratum.rejected); } else { g_stratum.rejected++; ESP_LOGW(TAG, "share REJECTED: %.160s", line);
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
        uint32_t H[8]; job_hash(c.w, c.nonce_word, H); double d = job_diff(H), pd = stratum_pool_diff(), nd = g_stratum.net_diff;
        stratum_best(d);
        bool block = nd > 0 && d + 1e-9 >= nd;
        if (H[7] == 0) ESP_LOGW(TAG, "*** diff-1+ hash found: %08x%08x... diff %.3f%s", (unsigned)__builtin_bswap32(H[7]), (unsigned)__builtin_bswap32(H[6]), d, block ? " - A BLOCK" : "");
        if (d + 1e-12 < pd && !block) continue;   // below the pool's target: not a share (a block always is one)
        recent_job_t cur; session_t ss; bool have = false;
        xSemaphoreTake(s_lock, portMAX_DELAY);
        for (int i = 0; i < s_nrecent; i++) if (s_recent[i].seq == c.job_seq) {
            // a replaced job: its shares are stale, unless the newest job builds on the same previous block (a template
            // refresh sent as clean); a block goes out regardless
            if (s_recent[i].replaced && !block && !(!s_recent[0].replaced && !memcmp(s_recent[0].prev, s_recent[i].prev, sizeof s_recent[i].prev))) break;
            cur = s_recent[i]; memcpy(&ss, &s_sess, sizeof ss); have = true; if (i) g_stratum.old_job_submits++; break; }
        xSemaphoreGive(s_lock);
        if (!have) { g_stratum.stale_dropped++; ESP_LOGW(TAG, "stale candidate, job changed"); continue; }
        if (ss.en2_size == 0) { g_stratum.stale_dropped++; continue; }   // between sessions
        char en2hex[17]; uint8_t en2b[8]; for (int i = 0; i < ss.en2_size; i++) en2b[i] = (i < 4) ? (c.en2 >> (8 * i)) & 0xff : 0; bin2hex(en2b, ss.en2_size, en2hex);
        uint32_t nonce = __builtin_bswap32(c.nonce_word);
        char line[512]; uint32_t id = ++s_id;
        snprintf(line, sizeof line, "{\"id\":%u,\"method\":\"mining.submit\",\"params\":[\"%s\",\"%s\",\"%s\",\"%s\",\"%08x\"]}\n", (unsigned)id, g_stratum.user, cur.job_id, en2hex, cur.ntime_hex, (unsigned)nonce);
        if (send_line(line) == 0) { g_stratum.submitted++; g_stratum.last_share_diff = d; if (s_npend < 64) s_pending_submit_ids[s_npend++] = id; ESP_LOGI(TAG, "submit nonce %08x diff %.4f (pool %.4f)", (unsigned)nonce, d, pd); }
        else { g_stratum.submit_lost++; if (block) ESP_LOGE(TAG, "a BLOCK could not be sent: %s", line); }
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
            do_submits();   // before the lines: a notify among them could make a waiting share stale
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
        do_submits();   // a block found just before the connection dropped is lost anyway, but the counters stay right
        xSemaphoreTake(s_lock, portMAX_DELAY); s_job.seq = 0; s_nrecent = 0; xSemaphoreGive(s_lock);
        vTaskDelay(pdMS_TO_TICKS(3000));
    }
}
void stratum_start(void) {
    s_lock = xSemaphoreCreateMutex(); s_cands = xQueueCreate(32, sizeof(candidate_t)); stratum_set_pool_diff(1.0); g_stratum.solo = -1;
    s_spklen = addr_script(g_cfg.wallet, s_spk); if (!s_spklen) ESP_LOGW(TAG, "payout address does not parse: solo detection off");
#ifdef CONFIG_SPIRAM
    // PSRAM boards: the camera's DMA buffers leave little internal RAM, and this task never touches flash, so its stack can live in PSRAM
    xTaskCreatePinnedToCoreWithCaps(task, "stratum", 24576, NULL, 5, NULL, 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
#else
    xTaskCreatePinnedToCore(task, "stratum", 24576, NULL, 5, NULL, 1);
#endif
}
