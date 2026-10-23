#!/bin/sh
# The stratum TLS certificate (ports 3443/3444) is the certbot wildcard *.bumblebeam.org, copied where the pool
# (uid 10001) can read it: certbot keeps its key root-only. Run daily from the host's cron:
#   sudo install -m 755 pool-tls-sync.sh /etc/cron.daily/bumblebeam-pool-tls
# It copies a renewed certificate into place; pool-stratum notices the changed files within 10 minutes and
# serves the new one without a restart (stratum.rs ReloadingCert). Nothing happens while the copy is current.
set -eu
LIVE=${LIVE:-/data/bumblebeam/letsencrypt/live/bumblebeam.org}
DEST=${DEST:-/data/bumblebeam/pool/tls}
[ -r "$LIVE/fullchain.pem" ] && [ -r "$LIVE/privkey.pem" ] || { echo "pool-tls-sync: no certificate in $LIVE" >&2; exit 1; }
new=$(openssl x509 -in "$LIVE/fullchain.pem" -noout -fingerprint -sha256)
old=$(openssl x509 -in "$DEST/pool.crt" -noout -fingerprint -sha256 2>/dev/null || true)
[ "$new" = "$old" ] && exit 0
# the key first, then the certificate, each through a temporary name: the pool reloads only a pair that loads
install -m 600 -o 10001 -g 10001 "$LIVE/privkey.pem" "$DEST/.pool.key.new" && mv "$DEST/.pool.key.new" "$DEST/pool.key"
install -m 644 -o 10001 -g 10001 "$LIVE/fullchain.pem" "$DEST/.pool.crt.new" && mv "$DEST/.pool.crt.new" "$DEST/pool.crt"
echo "pool-tls-sync: stratum certificate updated ($(openssl x509 -in "$DEST/pool.crt" -noout -enddate))"
logger -t pool-tls-sync "stratum certificate updated" 2>/dev/null || true
