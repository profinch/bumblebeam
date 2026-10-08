#!/bin/sh
# Stratum TLS with the site's Let's Encrypt certificate (*.bumblebeam.org covers the stratum name).
# certbot renews into /data/bumblebeam/letsencrypt (root only); the pool runs as uid 10001 and
# loads its certificate at start. So: copy the live certificate and key to the pool's tls/ when
# they changed, then restart the pool. Run daily by pool-tls-sync.timer, after the renewal.
set -eu
LIVE=/data/bumblebeam/letsencrypt/live/bumblebeam.org
DST=/data/bumblebeam/pool/tls
[ -s "$LIVE/fullchain.pem" ] && [ -s "$LIVE/privkey.pem" ] || { echo "no certificate in $LIVE" >&2; exit 1; }
if cmp -s "$LIVE/fullchain.pem" "$DST/pool.crt" && cmp -s "$LIVE/privkey.pem" "$DST/pool.key"; then
    exit 0
fi
install -m 644 -o 10001 -g 10001 "$LIVE/fullchain.pem" "$DST/pool.crt.new"
install -m 600 -o 10001 -g 10001 "$LIVE/privkey.pem" "$DST/pool.key.new"
mv "$DST/pool.crt.new" "$DST/pool.crt"
mv "$DST/pool.key.new" "$DST/pool.key"
docker restart bumblebeam-pool >/dev/null
echo "stratum certificate updated: $(openssl x509 -in "$DST/pool.crt" -noout -enddate)"
