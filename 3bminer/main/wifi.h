#pragma once
#include <stdbool.h>
void wifi_start(void);
bool wifi_connected(void);
#include <stdint.h>
extern volatile int64_t g_ntp_sync;      // the board clock's last NTP sync (Unix seconds), 0 = never
extern const char *volatile g_ntp_server;   // the time server that set the clock last
int wifi_rssi(void);
const char *wifi_ip(void);
