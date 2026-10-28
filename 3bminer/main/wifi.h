#pragma once
#include <stdbool.h>
void wifi_start(void);
bool wifi_connected(void);
int wifi_rssi(void);
const char *wifi_ip(void);
