// camera boards: esp32-camera driver + the CameraWebServer HTTP API (same paths and parameters, so its tools keep working)
//   :80  /capture /bmp /status /control?var=&val= /xclk /reg /greg /pll /resolution, /api/camera/save (ours: keep settings in NVS)
//   :81  /stream (MJPEG), its own server so a running stream never blocks the dashboard
#include "camera.h"
#include "web.h"
#include "sdkconfig.h"
#ifdef CONFIG_BOARD_HAS_CAMERA
#include "esp_camera.h"
#include "img_converters.h"
#include "driver/ledc.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "nvs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <time.h>
#include <sys/stat.h>
#include "esp_vfs_fat.h"
#include "driver/sdmmc_host.h"
#include "sdmmc_cmd.h"
static const char *TAG = "camera";

// AI-Thinker ESP32-CAM
#define PIN_PWDN 32
#define PIN_XCLK 0
#define PIN_SIOD 26
#define PIN_SIOC 27
#define PIN_D7 35
#define PIN_D6 34
#define PIN_D5 39
#define PIN_D4 36
#define PIN_D3 21
#define PIN_D2 19
#define PIN_D1 18
#define PIN_D0 5
#define PIN_VSYNC 25
#define PIN_HREF 23
#define PIN_PCLK 22
#define PIN_FLASH 4                  // white flash LED, LEDC PWM (timer/channel 1: 0 is the sensor XCLK)
#define FLASH_MAX 255

static volatile bool s_ok = false;
static int s_led = 0;                // flash intensity 0..255, lit while streaming and for a capture
static volatile bool s_streaming = false;
static volatile float s_fps = 0;
static sdmmc_card_t *s_card; static esp_err_t s_sd_err = ESP_ERR_NOT_FOUND; static void sd_mount(bool fmt);   // microSD, below

static void led_set(int duty) { ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_1, duty > FLASH_MAX ? FLASH_MAX : duty); ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_1); }
static void led_init(void) {
    ledc_timer_config_t t = { .speed_mode = LEDC_LOW_SPEED_MODE, .duty_resolution = LEDC_TIMER_8_BIT, .timer_num = LEDC_TIMER_1, .freq_hz = 5000, .clk_cfg = LEDC_AUTO_CLK };
    ledc_timer_config(&t);
    ledc_channel_config_t c = { .gpio_num = PIN_FLASH, .speed_mode = LEDC_LOW_SPEED_MODE, .channel = LEDC_CHANNEL_1, .timer_sel = LEDC_TIMER_1, .duty = 0 };
    ledc_channel_config(&c);
}

// one setter table for /control, /status and the NVS copy
static int apply(sensor_t *s, const char *var, int val) {
    if (!strcmp(var, "framesize")) { if (s->pixformat != PIXFORMAT_JPEG) return -1; return s->set_framesize(s, (framesize_t)val); }
    if (!strcmp(var, "quality")) return s->set_quality(s, val);
    if (!strcmp(var, "contrast")) return s->set_contrast(s, val);
    if (!strcmp(var, "brightness")) return s->set_brightness(s, val);
    if (!strcmp(var, "saturation")) return s->set_saturation(s, val);
    if (!strcmp(var, "sharpness")) return s->set_sharpness(s, val);
    if (!strcmp(var, "gainceiling")) return s->set_gainceiling(s, (gainceiling_t)val);
    if (!strcmp(var, "colorbar")) return s->set_colorbar(s, val);
    if (!strcmp(var, "awb")) return s->set_whitebal(s, val);
    if (!strcmp(var, "agc")) return s->set_gain_ctrl(s, val);
    if (!strcmp(var, "aec")) return s->set_exposure_ctrl(s, val);
    if (!strcmp(var, "hmirror")) return s->set_hmirror(s, val);
    if (!strcmp(var, "vflip")) return s->set_vflip(s, val);
    if (!strcmp(var, "awb_gain")) return s->set_awb_gain(s, val);
    if (!strcmp(var, "agc_gain")) return s->set_agc_gain(s, val);
    if (!strcmp(var, "aec_value")) return s->set_aec_value(s, val);
    if (!strcmp(var, "aec2")) return s->set_aec2(s, val);
    if (!strcmp(var, "dcw")) return s->set_dcw(s, val);
    if (!strcmp(var, "bpc")) return s->set_bpc(s, val);
    if (!strcmp(var, "wpc")) return s->set_wpc(s, val);
    if (!strcmp(var, "raw_gma")) return s->set_raw_gma(s, val);
    if (!strcmp(var, "lenc")) return s->set_lenc(s, val);
    if (!strcmp(var, "special_effect")) return s->set_special_effect(s, val);
    if (!strcmp(var, "wb_mode")) return s->set_wb_mode(s, val);
    if (!strcmp(var, "ae_level")) return s->set_ae_level(s, val);
    if (!strcmp(var, "led_intensity")) { s_led = val < 0 ? 0 : val > FLASH_MAX ? FLASH_MAX : val; if (s_streaming) led_set(s_led); return 0; }
    return -1;
}
static const char *const SAVED[] = { "framesize", "quality", "contrast", "brightness", "saturation", "sharpness", "gainceiling", "colorbar", "awb", "agc", "aec",
    "hmirror", "vflip", "awb_gain", "agc_gain", "aec_value", "aec2", "dcw", "bpc", "wpc", "raw_gma", "lenc", "special_effect", "wb_mode", "ae_level", "led_intensity" };
#define NSAVED (sizeof SAVED / sizeof SAVED[0])
static int current(sensor_t *s, const char *v) {
    camera_status_t *t = &s->status;
    if (!strcmp(v, "framesize")) return t->framesize;
    if (!strcmp(v, "quality")) return t->quality;
    if (!strcmp(v, "contrast")) return t->contrast;
    if (!strcmp(v, "brightness")) return t->brightness;
    if (!strcmp(v, "saturation")) return t->saturation;
    if (!strcmp(v, "sharpness")) return t->sharpness;
    if (!strcmp(v, "gainceiling")) return t->gainceiling;
    if (!strcmp(v, "colorbar")) return t->colorbar;
    if (!strcmp(v, "awb")) return t->awb;
    if (!strcmp(v, "agc")) return t->agc;
    if (!strcmp(v, "aec")) return t->aec;
    if (!strcmp(v, "hmirror")) return t->hmirror;
    if (!strcmp(v, "vflip")) return t->vflip;
    if (!strcmp(v, "awb_gain")) return t->awb_gain;
    if (!strcmp(v, "agc_gain")) return t->agc_gain;
    if (!strcmp(v, "aec_value")) return t->aec_value;
    if (!strcmp(v, "aec2")) return t->aec2;
    if (!strcmp(v, "dcw")) return t->dcw;
    if (!strcmp(v, "bpc")) return t->bpc;
    if (!strcmp(v, "wpc")) return t->wpc;
    if (!strcmp(v, "raw_gma")) return t->raw_gma;
    if (!strcmp(v, "lenc")) return t->lenc;
    if (!strcmp(v, "special_effect")) return t->special_effect;
    if (!strcmp(v, "wb_mode")) return t->wb_mode;
    if (!strcmp(v, "ae_level")) return t->ae_level;
    if (!strcmp(v, "led_intensity")) return s_led;
    return 0;
}
static void settings_load(sensor_t *s) {
    nvs_handle_t h; if (nvs_open("camera", NVS_READONLY, &h) != ESP_OK) return;
    int n = 0; for (unsigned i = 0; i < NSAVED; i++) { int32_t v; if (nvs_get_i32(h, SAVED[i], &v) == ESP_OK) { apply(s, SAVED[i], v); n++; } }
    nvs_close(h); ESP_LOGI(TAG, "%d saved settings applied", n);
}
static bool settings_save(sensor_t *s) {
    nvs_handle_t h; if (nvs_open("camera", NVS_READWRITE, &h) != ESP_OK) return false;
    for (unsigned i = 0; i < NSAVED; i++) nvs_set_i32(h, SAVED[i], current(s, SAVED[i]));
    bool ok = nvs_commit(h) == ESP_OK; nvs_close(h); return ok;
}

void camera_start(void) {
    led_init();
    camera_config_t c = {
        .pin_pwdn = PIN_PWDN, .pin_reset = -1, .pin_xclk = PIN_XCLK, .pin_sccb_sda = PIN_SIOD, .pin_sccb_scl = PIN_SIOC,
        .pin_d7 = PIN_D7, .pin_d6 = PIN_D6, .pin_d5 = PIN_D5, .pin_d4 = PIN_D4, .pin_d3 = PIN_D3, .pin_d2 = PIN_D2, .pin_d1 = PIN_D1, .pin_d0 = PIN_D0,
        .pin_vsync = PIN_VSYNC, .pin_href = PIN_HREF, .pin_pclk = PIN_PCLK,
        .xclk_freq_hz = 20000000, .ledc_timer = LEDC_TIMER_0, .ledc_channel = LEDC_CHANNEL_0,
        // buffers sized for the largest frame (UXGA) in PSRAM, so any resolution can be picked later. Grab only when a buffer is free: with
        // LATEST the driver copies every frame into PSRAM with the CPU even when nobody watches, and that is core 1, where Wi-Fi and lwip run
        .pixel_format = PIXFORMAT_JPEG, .frame_size = FRAMESIZE_UXGA, .jpeg_quality = 10, .fb_count = 2, .fb_location = CAMERA_FB_IN_PSRAM, .grab_mode = CAMERA_GRAB_WHEN_EMPTY,
    };
    esp_err_t e = esp_camera_init(&c);
    if (e != ESP_OK) { ESP_LOGE(TAG, "camera init failed 0x%x", e); return; }
    // the driver's grab task runs at configMAX_PRIORITIES-2 (= Wi-Fi's); under lwip (18) it can no longer starve the network
    TaskHandle_t ct = xTaskGetHandle("cam_task"); if (ct) vTaskPrioritySet(ct, 10);
    sensor_t *s = esp_camera_sensor_get();
    if (s->id.PID == OV3660_PID) { s->set_vflip(s, 1); s->set_brightness(s, 1); s->set_saturation(s, -2); }   // as CameraWebServer: OV3660 comes up flipped and oversaturated
    s->set_framesize(s, FRAMESIZE_QVGA);   // start small for a fast first stream, as CameraWebServer
    settings_load(s);
    s_ok = true;
    if (!s_card) sd_mount(false);
    ESP_LOGI(TAG, "sensor PID 0x%04x ready, framesize %d", s->id.PID, s->status.framesize);
}

static esp_err_t cors(httpd_req_t *r) { web_cors(r); return ESP_OK; }
static esp_err_t not_ready(httpd_req_t *r) { httpd_resp_set_status(r, "503 Service Unavailable"); return httpd_resp_send(r, "camera not ready", -1); }
static int qint(httpd_req_t *r, const char *k, int def) {
    char q[200], v[16]; if (httpd_req_get_url_query_str(r, q, sizeof q) != ESP_OK || httpd_query_key_value(q, k, v, sizeof v) != ESP_OK) return def; return atoi(v);
}

static esp_err_t h_capture(httpd_req_t *r) {
    if (!s_ok) return not_ready(r);
    if (s_led) { led_set(s_led); vTaskDelay(pdMS_TO_TICKS(150)); }   // let exposure settle on the flash, as CameraWebServer
    camera_fb_t *fb = esp_camera_fb_get();
    if (fb && !s_streaming) { esp_camera_fb_return(fb); fb = esp_camera_fb_get(); }   // the queued frame may be old (grab-when-empty): take the next one
    if (s_led && !s_streaming) led_set(0);
    if (!fb) { httpd_resp_send_500(r); return ESP_FAIL; }
    httpd_resp_set_type(r, "image/jpeg"); httpd_resp_set_hdr(r, "Content-Disposition", "inline; filename=capture.jpg"); cors(r);
    char ts[32]; snprintf(ts, sizeof ts, "%lld.%06ld", (long long)fb->timestamp.tv_sec, (long)fb->timestamp.tv_usec); httpd_resp_set_hdr(r, "X-Timestamp", ts);
    esp_err_t res;
    if (fb->format == PIXFORMAT_JPEG) res = httpd_resp_send(r, (const char *)fb->buf, fb->len);
    else { uint8_t *jpg = NULL; size_t n = 0; bool ok = frame2jpg(fb, 80, &jpg, &n); res = ok ? httpd_resp_send(r, (const char *)jpg, n) : httpd_resp_send_500(r); free(jpg); }
    esp_camera_fb_return(fb); return res;
}
static esp_err_t h_bmp(httpd_req_t *r) {
    if (!s_ok) return not_ready(r);
    camera_fb_t *fb = esp_camera_fb_get(); if (!fb) { httpd_resp_send_500(r); return ESP_FAIL; }
    uint8_t *bmp = NULL; size_t n = 0; bool ok = frame2bmp(fb, &bmp, &n); esp_camera_fb_return(fb);
    if (!ok) { httpd_resp_send_500(r); return ESP_FAIL; }
    httpd_resp_set_type(r, "image/x-windows-bmp"); httpd_resp_set_hdr(r, "Content-Disposition", "inline; filename=capture.bmp"); cors(r);
    esp_err_t res = httpd_resp_send(r, (const char *)bmp, n); free(bmp); return res;
}
static esp_err_t h_status(httpd_req_t *r) {
    if (!s_ok) return not_ready(r);
    sensor_t *s = esp_camera_sensor_get(); char b[1100]; int n = snprintf(b, sizeof b, "{");
    if (s->id.PID == OV2640_PID) n += snprintf(b + n, sizeof b - n, "\"0xd3\":%d,\"0x111\":%d,\"0x132\":%d,", s->get_reg(s, 0xd3, 0xFF), s->get_reg(s, 0x111, 0xFF), s->get_reg(s, 0x132, 0xFF));
    n += snprintf(b + n, sizeof b - n, "\"pid\":%d,\"xclk\":%d,\"pixformat\":%d,\"streaming\":%s,\"fps\":%.1f", s->id.PID, s->xclk_freq_hz / 1000000, s->pixformat, s_streaming ? "true" : "false", s_fps);
    for (unsigned i = 0; i < NSAVED; i++) n += snprintf(b + n, sizeof b - n, ",\"%s\":%d", SAVED[i], current(s, SAVED[i]));
    snprintf(b + n, sizeof b - n, "}");
    httpd_resp_set_type(r, "application/json"); cors(r); return httpd_resp_send(r, b, -1);
}
static esp_err_t h_control(httpd_req_t *r) {
    if (!web_get_allowed(r)) return ESP_OK;
    if (!s_ok) return not_ready(r);
    char q[128], var[32], val[16];
    if (httpd_req_get_url_query_str(r, q, sizeof q) != ESP_OK || httpd_query_key_value(q, "var", var, sizeof var) != ESP_OK || httpd_query_key_value(q, "val", val, sizeof val) != ESP_OK) return httpd_resp_send_404(r);
    int res = apply(esp_camera_sensor_get(), var, atoi(val));
    if (res < 0) { ESP_LOGW(TAG, "unknown or rejected: %s=%s", var, val); return httpd_resp_send_500(r); }
    cors(r); return httpd_resp_send(r, NULL, 0);
}
static esp_err_t h_xclk(httpd_req_t *r) {
    if (!web_get_allowed(r)) return ESP_OK;
    if (!s_ok) return not_ready(r);
    int x = qint(r, "xclk", -1); if (x <= 0) return httpd_resp_send_404(r);
    sensor_t *s = esp_camera_sensor_get(); if (s->set_xclk(s, LEDC_TIMER_0, x)) return httpd_resp_send_500(r);
    cors(r); return httpd_resp_send(r, NULL, 0);
}
static esp_err_t h_reg(httpd_req_t *r) {
    if (!web_get_allowed(r)) return ESP_OK;
    if (!s_ok) return not_ready(r);
    int reg = qint(r, "reg", -1), mask = qint(r, "mask", -1), val = qint(r, "val", -1); if (reg < 0 || mask < 0 || val < 0) return httpd_resp_send_404(r);
    sensor_t *s = esp_camera_sensor_get(); if (s->set_reg(s, reg, mask, val)) return httpd_resp_send_500(r);
    cors(r); return httpd_resp_send(r, NULL, 0);
}
static esp_err_t h_greg(httpd_req_t *r) {
    if (!s_ok) return not_ready(r);
    int reg = qint(r, "reg", -1), mask = qint(r, "mask", -1); if (reg < 0 || mask < 0) return httpd_resp_send_404(r);
    sensor_t *s = esp_camera_sensor_get(); int v = s->get_reg(s, reg, mask); if (v < 0) return httpd_resp_send_500(r);
    char b[16]; snprintf(b, sizeof b, "%d", v); cors(r); return httpd_resp_send(r, b, -1);
}
static esp_err_t h_pll(httpd_req_t *r) {
    if (!web_get_allowed(r)) return ESP_OK;
    if (!s_ok) return not_ready(r);
    sensor_t *s = esp_camera_sensor_get();
    if (s->set_pll(s, qint(r, "bypass", 0), qint(r, "mul", 0), qint(r, "sys", 0), qint(r, "root", 0), qint(r, "pre", 0), qint(r, "seld5", 0), qint(r, "pclken", 0), qint(r, "pclk", 0))) return httpd_resp_send_500(r);
    cors(r); return httpd_resp_send(r, NULL, 0);
}
static esp_err_t h_resolution(httpd_req_t *r) {
    if (!web_get_allowed(r)) return ESP_OK;
    if (!s_ok) return not_ready(r);
    sensor_t *s = esp_camera_sensor_get();
    if (s->set_res_raw(s, qint(r, "sx", 0), qint(r, "sy", 0), qint(r, "ex", 0), qint(r, "ey", 0), qint(r, "offx", 0), qint(r, "offy", 0), qint(r, "tx", 0), qint(r, "ty", 0), qint(r, "ox", 0), qint(r, "oy", 0), qint(r, "scale", 0), qint(r, "binning", 0)))
        return httpd_resp_send_500(r);
    cors(r); return httpd_resp_send(r, NULL, 0);
}
static esp_err_t h_save(httpd_req_t *r) {
    if (!web_post_allowed(r)) return ESP_OK;
    if (!s_ok) return not_ready(r);
    bool ok = settings_save(esp_camera_sensor_get());
    httpd_resp_set_type(r, "application/json"); cors(r); return httpd_resp_send(r, ok ? "{\"status\":\"ok\"}" : "{\"status\":\"nvs error\"}", -1);
}

#define BOUNDARY "123456789000000000000987654321"
static esp_err_t h_stream(httpd_req_t *r) {
    if (!s_ok) return not_ready(r);
    httpd_resp_set_type(r, "multipart/x-mixed-replace;boundary=" BOUNDARY); cors(r); httpd_resp_set_hdr(r, "X-Framerate", "60");
    s_streaming = true; if (s_led) led_set(s_led);
    int64_t t_last = esp_timer_get_time(); int frames = 0; esp_err_t res = ESP_OK;
    while (res == ESP_OK && s_ok) {
        camera_fb_t *fb = esp_camera_fb_get(); if (!fb) { ESP_LOGW(TAG, "frame grab failed"); res = ESP_FAIL; break; }
        uint8_t *jpg = fb->buf; size_t n = fb->len; bool conv = false;
        if (fb->format != PIXFORMAT_JPEG) { conv = frame2jpg(fb, 80, &jpg, &n); if (!conv) { esp_camera_fb_return(fb); res = ESP_FAIL; break; } }
        char part[128]; int pl = snprintf(part, sizeof part, "\r\n--" BOUNDARY "\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\nX-Timestamp: %lld.%06ld\r\n\r\n", (unsigned)n, (long long)fb->timestamp.tv_sec, (long)fb->timestamp.tv_usec);
        res = httpd_resp_send_chunk(r, part, pl);
        if (res == ESP_OK) res = httpd_resp_send_chunk(r, (const char *)jpg, n);
        if (conv) free(jpg);
        esp_camera_fb_return(fb);
        if (++frames == 20) { int64_t now = esp_timer_get_time(); s_fps = 20e6f / (now - t_last); t_last = now; frames = 0; }
    }
    s_streaming = false; s_fps = 0; led_set(0);
    return res;
}

// Flash writes disable the cache on both cores; the camera's DMA interrupt keeps firing meanwhile, its queue overflows
// and core 0 ended in the coprocessor-exception vector until the interrupt watchdog reset the board mid-OTA.
void camera_stop(void) {
    if (!s_ok) return;
    s_ok = false;   // a running /stream (its own server task) leaves after the frame it is sending; /capture runs in this server task
    for (int i = 0; i < 100 && s_streaming; i++) vTaskDelay(pdMS_TO_TICKS(20));
    led_set(0); esp_camera_deinit(); ESP_LOGI(TAG, "camera stopped");
}
// microSD in the slot: SDMMC in 1-bit mode (CLK 14, CMD 15, D0 2) so GPIO4 stays the flash LED (it is D1 in 4-bit
// mode). FAT; a card that does not mount is left alone until it is formatted from the page. Writes to the card do not
// touch the board's flash, so they are safe with the camera running.
#define SD_PATH "/sdcard"
static void sd_mount(bool fmt) {   // fmt: a card without FAT gets one (the Format button)
    sdmmc_host_t host = SDMMC_HOST_DEFAULT(); host.flags = SDMMC_HOST_FLAG_1BIT; host.max_freq_khz = SDMMC_FREQ_HIGHSPEED;
    sdmmc_slot_config_t slot = SDMMC_SLOT_CONFIG_DEFAULT(); slot.width = 1; slot.flags |= SDMMC_SLOT_FLAG_INTERNAL_PULLUP;
    esp_vfs_fat_sdmmc_mount_config_t mc = { .format_if_mount_failed = fmt, .max_files = 3, .allocation_unit_size = 32 * 1024 };
    s_sd_err = esp_vfs_fat_sdmmc_mount(SD_PATH, &host, &slot, &mc, &s_card);
    if (s_sd_err == ESP_OK) ESP_LOGI(TAG, "SD card %s, %llu MB", s_card->cid.name, (unsigned long long)s_card->csd.capacity * s_card->csd.sector_size >> 20);
    else ESP_LOGW(TAG, "SD card: %s", esp_err_to_name(s_sd_err));
}
static esp_err_t json(httpd_req_t *r, const char *b) { httpd_resp_set_type(r, "application/json"); cors(r); return httpd_resp_send(r, b, -1); }
static esp_err_t h_sd(httpd_req_t *r) {   // GET /api/sd: the card, its size and free space
    char b[256];
    if (!s_card && s_sd_err == ESP_FAIL) return json(r, "{\"card\":true,\"mounted\":false,\"error\":\"no FAT file system: format it\"}");   // the driver lets go of a card it cannot mount
    if (!s_card) { snprintf(b, sizeof b, "{\"card\":false,\"error\":\"%s\"}", s_sd_err == ESP_ERR_TIMEOUT || s_sd_err == ESP_ERR_NOT_FOUND || s_sd_err == ESP_ERR_INVALID_RESPONSE ? "no card" : esp_err_to_name(s_sd_err)); return json(r, b); }
    uint64_t tot = 0, fr = 0; bool fs = s_sd_err == ESP_OK && esp_vfs_fat_info(SD_PATH, &tot, &fr) == ESP_OK;
    char nm[8]; int k = 0; for (const char *q = s_card->cid.name; *q && k < 7; q++) if (*q >= 32 && *q != '"' && *q != '\\') nm[k++] = *q; nm[k] = 0;
    snprintf(b, sizeof b, "{\"card\":true,\"name\":\"%s\",\"sizeMB\":%llu,\"mounted\":%s,\"totalMB\":%llu,\"freeMB\":%llu,\"error\":%s%s%s}", nm,
        (unsigned long long)s_card->csd.capacity * s_card->csd.sector_size >> 20, fs ? "true" : "false", (unsigned long long)(tot >> 20), (unsigned long long)(fr >> 20),
        fs ? "" : "\"", fs ? "null" : "not FAT: format it", fs ? "" : "\"");
    return json(r, b);
}
static esp_err_t h_sd_format(httpd_req_t *r) {   // POST /api/sd/format: a new FAT on the whole card
    if (!web_post_allowed(r)) return ESP_OK;
    esp_err_t e;
    if (!s_card) { sd_mount(true); e = s_sd_err; if (!s_card) return json(r, "{\"status\":\"no card\"}"); }   // mounting with format makes the FAT
    else { e = esp_vfs_fat_sdcard_format(SD_PATH, s_card); if (e == ESP_OK) s_sd_err = ESP_OK; }
    ESP_LOGI(TAG, "SD format: %s", esp_err_to_name(e));
    char b[96]; snprintf(b, sizeof b, "{\"status\":\"%s\"}", e == ESP_OK ? "ok" : esp_err_to_name(e)); return json(r, b);
}
static esp_err_t h_sd_snap(httpd_req_t *r) {   // POST /api/sd/snap: the next frame to the card as /photos/<date>_<time>.jpg
    if (!web_post_allowed(r)) return ESP_OK;
    if (!s_ok) return not_ready(r);
    if (!s_card || s_sd_err != ESP_OK) return json(r, "{\"status\":\"no card\"}");
    camera_fb_t *fb = esp_camera_fb_get(); if (fb && !s_streaming) { esp_camera_fb_return(fb); fb = esp_camera_fb_get(); }
    if (!fb) return httpd_resp_send_500(r);
    mkdir(SD_PATH "/photos", 0775);
    char name[64]; time_t t = time(NULL); struct tm tm; localtime_r(&t, &tm);
    char base[48]; if (t > 1700000000) strftime(base, sizeof base, SD_PATH "/photos/%Y-%m-%d_%H-%M-%S", &tm); else snprintf(base, sizeof base, SD_PATH "/photos/boot-%lld", (long long)(esp_timer_get_time() / 1000));
    struct stat st; snprintf(name, sizeof name, "%s.jpg", base); for (int i = 2; i < 100 && stat(name, &st) == 0; i++) snprintf(name, sizeof name, "%s-%d.jpg", base, i);   // several in one second
    FILE *f = fopen(name, "wb"); size_t w = 0, n = fb->len; if (f) { w = fwrite(fb->buf, 1, n, f); fclose(f); } esp_camera_fb_return(fb);
    char b[128]; snprintf(b, sizeof b, "{\"status\":\"%s\",\"file\":\"%s\",\"bytes\":%u}", f && w == n ? "ok" : "write failed", name + sizeof SD_PATH, (unsigned)w);
    return json(r, b);
}
int camera_http_handler_count(void) { return 13; }
bool camera_streaming(void) { return s_streaming; }
void camera_register_http(httpd_handle_t s) {
    const httpd_uri_t u[] = {
        { .uri = "/capture", .method = HTTP_GET, .handler = h_capture }, { .uri = "/bmp", .method = HTTP_GET, .handler = h_bmp },
        { .uri = "/status", .method = HTTP_GET, .handler = h_status }, { .uri = "/control", .method = HTTP_GET, .handler = h_control },
        { .uri = "/xclk", .method = HTTP_GET, .handler = h_xclk }, { .uri = "/reg", .method = HTTP_GET, .handler = h_reg },
        { .uri = "/greg", .method = HTTP_GET, .handler = h_greg }, { .uri = "/pll", .method = HTTP_GET, .handler = h_pll },
        { .uri = "/resolution", .method = HTTP_GET, .handler = h_resolution }, { .uri = "/api/camera/save", .method = HTTP_POST, .handler = h_save },
        { .uri = "/api/sd", .method = HTTP_GET, .handler = h_sd }, { .uri = "/api/sd/format", .method = HTTP_POST, .handler = h_sd_format }, { .uri = "/api/sd/snap", .method = HTTP_POST, .handler = h_sd_snap } };
    for (unsigned i = 0; i < sizeof u / sizeof u[0]; i++) httpd_register_uri_handler(s, &u[i]);
    // the stream gets its own server (port 81, as CameraWebServer), pinned to core 1 like everything else
    httpd_config_t c = HTTPD_DEFAULT_CONFIG(); c.server_port = 81; c.ctrl_port = 32769; c.core_id = 1; c.max_open_sockets = 3; c.stack_size = 6144; c.lru_purge_enable = true;
    httpd_handle_t ss; if (httpd_start(&ss, &c) != ESP_OK) { ESP_LOGE(TAG, "stream server failed"); return; }
    const httpd_uri_t st = { .uri = "/stream", .method = HTTP_GET, .handler = h_stream }; httpd_register_uri_handler(ss, &st);
}
#else
void camera_start(void) {}
void camera_stop(void) {}
bool camera_streaming(void) { return false; }
void camera_register_http(httpd_handle_t s) { (void)s; }
int camera_http_handler_count(void) { return 0; }
#endif
