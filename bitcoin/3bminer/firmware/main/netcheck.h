#pragma once
#include <stdbool.h>
// Checks on names, addresses and request text that need no hardware (tests/test_host.c runs them on the PC)
bool net_ipv4(const char *h, unsigned *a, unsigned *b);      // a whole dotted IPv4 address; *a, *b its first two numbers
bool net_local_name(const char *h);                          // localhost, a bare name, .local, .lan, .home.arpa, .internal
bool net_lan_host(const char *host);                         // a private, loopback or link-local address, or a local name
bool net_host_part(char *h);                                 // cuts ":port" off a Host value; false for "[IPv6]" or empty
bool net_url_host(const char *v, char *host, int cap);       // host of an Origin/Referer URL; false if longer than cap
bool net_json_depth_ok(const char *s, int max);              // false when [ and { nest deeper than max (cJSON recurses)
