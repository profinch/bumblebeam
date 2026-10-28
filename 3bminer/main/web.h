#pragma once
#include <stdbool.h>
#include "esp_http_server.h"
void web_start(void);
bool web_post_allowed(httpd_req_t *r);   // false = refused (403 sent): a cross-site POST from outside the LAN
