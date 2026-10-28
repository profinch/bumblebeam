idf_component_register(SRCS "main.c" "sha256.c" "nerdsha.c" "config.c" "wifi.c" "job.c" "stratum.c" "miner.c" "mine.S" "mine2.S" "web.c" "camera.c" "history.c" "addr.c"
                       INCLUDE_DIRS "."
                       REQUIRES espressif__esp32-camera nvs_flash esp_wifi esp_netif esp_event esp_http_server app_update json esp_timer esp_hw_support driver lwip)
# web pages: www/index.html (built from web-next/ by web-next/build.py) and the favicon, gzipped at build time and served with Content-Encoding: gzip
foreach(f index.html favicon.svg)
    set(out "${CMAKE_CURRENT_BINARY_DIR}/${f}.gz")
    add_custom_command(OUTPUT "${out}" COMMAND python3 "${COMPONENT_DIR}/../tools/gzip_www.py" "${COMPONENT_DIR}/www/${f}" "${out}"
                       DEPENDS "${COMPONENT_DIR}/www/${f}" VERBATIM)
    add_custom_target(www_${f} DEPENDS "${out}")
    target_add_binary_data(${COMPONENT_LIB} "${out}" BINARY DEPENDS www_${f})
endforeach()
