#pragma once
#include <stdbool.h>
#include <stdint.h>
// background search for other miners on the board's subnet (see swarm.c); the list is what /alive answers
extern volatile bool g_ota_busy;            // set by the firmware upload: the search waits
void swarm_start(void);
bool swarm_add(uint32_t ip);                // a miner added by hand (network byte order), kept with the found ones
int swarm_alive_json(char *b, int cap, const char *self);
