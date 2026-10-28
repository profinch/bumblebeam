idf_component_register(EMBED_FILES "www/index.html.gz" SRCS "main.c" "sha256.c" "nerdsha.c" "config.c" "wifi.c" "job.c" "stratum.c" "miner.c" "mine.S" "mine2.S" "web.c"
                       INCLUDE_DIRS "."
                       REQUIRES nvs_flash esp_wifi esp_netif esp_event esp_http_server app_update json esp_timer esp_hw_support driver lwip)
