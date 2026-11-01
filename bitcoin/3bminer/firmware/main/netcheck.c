#include "netcheck.h"
#include <stdio.h>
#include <string.h>
// a whole IPv4 address and nothing after it: "10.1.evil.com" is a name, not an address
bool net_ipv4(const char *h, unsigned *a, unsigned *b) {
    unsigned c, d; int n = -1; return sscanf(h, "%3u.%3u.%3u.%3u%n", a, b, &c, &d, &n) == 4 && n == (int)strlen(h) && *a < 256 && *b < 256 && c < 256 && d < 256;
}
static bool ends(const char *h, const char *t) { int k = strlen(h), m = strlen(t); return k > m && !strcmp(h + k - m, t); }
// a name only the LAN resolves: localhost, a bare name, mDNS and the home suffixes; never one anybody can buy
bool net_local_name(const char *h) { return *h && (!strchr(h, '.') || ends(h, ".local") || ends(h, ".lan") || ends(h, ".home.arpa") || ends(h, ".internal")); }
bool net_lan_host(const char *host) {
    unsigned a, b; if (net_ipv4(host, &a, &b)) return a == 10 || a == 127 || (a == 192 && b == 168) || (a == 172 && b >= 16 && b <= 31) || (a == 169 && b == 254);
    return net_local_name(host);
}
// "host" or "host:port" from a Host header, a whole name or address only; the board has no IPv6, so "[...]" is refused
bool net_host_part(char *h) { if (h[0] == '[') return false; char *c = strchr(h, ':'); if (c) *c = 0; return *h; }
// the host of an Origin or Referer value ("http://host:port/..."); false for "null", an empty one, an IPv6 literal and a
// host longer than cap (cut, it could read as a bare LAN name)
bool net_url_host(const char *v, char *host, int cap) {
    const char *h = strstr(v, "://"); if (!h) return false; h += 3; if (*h == '[') return false; int k = 0;
    while (h[k] && h[k] != ':' && h[k] != '/') { if (k >= cap - 1) return false; host[k] = h[k]; k++; } host[k] = 0; return k > 0;
}
// cJSON recurses once per nesting level and the server task has an 8 KB stack: a body of a thousand '[' would overflow it.
// Settings and pool messages nest a few levels at most
bool net_json_depth_ok(const char *s, int max) {
    int d = 0; bool str = false;
    for (; *s; s++) { if (str) { if (*s == '\\' && s[1]) s++; else if (*s == '"') str = false; }
        else if (*s == '"') str = true; else if (*s == '[' || *s == '{') { if (++d > max) return false; } else if (*s == ']' || *s == '}') d--; }
    return true;
}
