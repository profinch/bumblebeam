#!/bin/bash
# One-time: wss.bumblebeam.org, bumblebeam's WebSocket name; its root is the door to beam-node for
# browser wallets (bridge/). Run it yourself on the server:
#   ssh -t bumblebeam 'sudo bash /data/docker/wss-setup.sh'
# (copy it there first: scp deploy/docker/wss-setup.sh deploy/docker/containers/nginx/conf/wss.conf bumblebeam:/tmp/)
#
# 1. beam-node.cfg: websocket_port=8200, websocket_use_tls=0 (backup next to it)
# 2. compose: beam-node publishes 127.0.0.1:8200 (backup next to it)
# 3. nginx: conf/wss.conf, checked with nginx -t, then reloaded
# 4. Cloudflare: A wss.bumblebeam.org -> this server, proxied (the certbot token, never printed)
# 5. beam-node recreated: the pool's stratum pauses while the node starts
set -euo pipefail
cd /data/docker
TS=$(date +%m%d%H%M)
CFG=/data/bumblebeam/node/beam-node.cfg
IP=65.109.125.69
NAME=wss.bumblebeam.org

echo "will: add websocket_port=8200 to $CFG, publish 127.0.0.1:8200 for beam-node, add nginx wss.conf,"
echo "      create DNS $NAME -> $IP (proxied), recreate beam-node (stratum pauses ~1-2 min)"
read -rp "go? [y/N] " a; [ "$a" = y ] || exit 1

cp -p "$CFG" "$CFG.bak-$TS"
grep -q '^websocket_port=' "$CFG" || printf '%s\n' \
  '# WebSocket door for browser wallets (bumblebeam bridge/): plain on 8200, 127.0.0.1 only, nginx adds TLS' \
  'websocket_port=8200' 'websocket_use_tls=0' >> "$CFG"

cp -p compose-bumblebeam.yaml "compose-bumblebeam.yaml.bak-$TS"
grep -q '127.0.0.1:8200:8200' compose-bumblebeam.yaml || \
  sed -i 's|^      - "10000:10000"\(.*\)$|      - "10000:10000"\1\n      - "127.0.0.1:8200:8200"             # WebSocket for browser wallets, behind nginx (wss.conf)|' compose-bumblebeam.yaml
grep -n '8200' compose-bumblebeam.yaml

cp /tmp/wss.conf containers/nginx/conf/wss.conf
docker exec bumblebeam-nginx nginx -t
docker exec bumblebeam-nginx nginx -s reload

python3 - "$NAME" "$IP" <<'EOF'
import json, sys, urllib.request
name, ip = sys.argv[1], sys.argv[2]
tok = json.load(open('/data/docker/containers/certbot/config.json'))['cloudflare']['api_token']
def cf(path, data=None, method=None):
    req = urllib.request.Request('https://api.cloudflare.com/client/v4' + path, method=method,
        data=json.dumps(data).encode() if data else None,
        headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req))
zone = cf('/zones?name=bumblebeam.org')['result'][0]['id']
if cf(f'/zones/{zone}/dns_records?name={name}')['result']:
    print('DNS record exists, left as is')
else:
    r = cf(f'/zones/{zone}/dns_records', {'type': 'A', 'name': name, 'content': ip, 'proxied': True, 'ttl': 1,
           'comment': 'bumblebeam WebSockets: / = beam-node for browser wallets (bridge/)'}, 'POST')
    print('DNS created' if r.get('success') else r)
EOF

docker compose -f compose-bumblebeam.yaml up -d beam-node
for i in $(seq 60); do
  curl -s -m 2 -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' http://127.0.0.1:8200/ | grep -q 101 && { echo "websocket up after ${i}x5 s"; break; }
  sleep 5
done
docker ps --format '{{.Names}} {{.Status}}' | grep -E 'beam-node|stratum|pool-app'
echo "done; backups: $CFG.bak-$TS, compose-bumblebeam.yaml.bak-$TS"
