#pragma once
#include "sdkconfig.h"
// one version for every board; the board id is baked into the image so OTA refuses a build for another board
#define FW_VERSION "0.10.1"
#define FW_BOARD_MARKER "3BMINER_BOARD=" CONFIG_BOARD_ID ";"
#ifdef CONFIG_BOARD_HAS_CAMERA
#define CONFIG_BOARD_HAS_CAMERA_STR "true"
#else
#define CONFIG_BOARD_HAS_CAMERA_STR "false"
#endif
