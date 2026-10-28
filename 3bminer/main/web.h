#pragma once
#include <stdbool.h>
#include "esp_http_server.h"
void web_start(void);
bool web_post_allowed(httpd_req_t *r);
bool web_get_allowed(httpd_req_t *r);    // false = refused (403 sent): a state-changing GET from a site outside the LAN
void web_cors(httpd_req_t *r);
const char *main_restart_why(void);     // "" or why the firmware last restarted itself (main.c)           // CORS for a LAN page only   // false = refused (403 sent): a cross-site POST from outside the LAN
