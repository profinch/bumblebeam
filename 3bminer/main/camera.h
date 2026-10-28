#pragma once
#include "esp_http_server.h"
// camera boards only (CONFIG_BOARD_HAS_CAMERA): OV2640/OV3660/OV5640 via esp32-camera, CameraWebServer-compatible API
void camera_start(void);                        // sensor + flash LED + stream server on :81
void camera_register_http(httpd_handle_t s);    // /capture /bmp /status /control /xclk /reg /greg /pll /resolution /api/camera/save
int camera_http_handler_count(void);
