# Deploying the pool

Two ways to the same result. The Docker stack in [`deploy/docker`](../deploy/docker) brings up
the node, `wallet-api`, PostgreSQL, the pool, nginx and certbot with one compose file, plus an
nftables ruleset for the host in [`deploy/host`](../deploy/host); start there for a rented
server. This page is the bare-metal version with systemd units, useful to understand what each
piece needs and for a machine that already runs some of it.

One Linux server runs everything: a Beam node, the pool's wallet behind `wallet-api`, PostgreSQL,
and `bumblebeam-pool`. Tested on Linux Mint 22 / Ubuntu 24.04 with Beam 7.5.14493. The layout
below uses `/opt/bumblebeam` for the repository and binary, `/etc/bumblebeam` for configuration
and secrets, `/var/lib/beam` for the node and wallet, and a system user `beam`; any other layout
works, adjust the paths in the units under [`pool/deploy`](../pool/deploy).

The same stack also runs in Docker: see [Docker](#docker) at the end. It is what runs
pool.bumblebeam.org.

## 1. Packages, Rust, PostgreSQL

```sh
sudo apt install -y git cmake ninja-build build-essential pkg-config libssl-dev unzip curl jq postgresql libpq-dev
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal && . ~/.cargo/env
sudo useradd -r -m -d /var/lib/beam -s /usr/sbin/nologin beam
sudo -u postgres psql -c "CREATE ROLE bumblebeam LOGIN PASSWORD '<strong password>'"
sudo -u postgres createdb -O bumblebeam bumblebeam
sudo install -d -m 750 -o beam -g beam /etc/bumblebeam
echo 'postgres://bumblebeam:<strong password>@127.0.0.1:5432/bumblebeam' | sudo tee /etc/bumblebeam/database.url >/dev/null
sudo chown beam:beam /etc/bumblebeam/database.url && sudo chmod 600 /etc/bumblebeam/database.url
```

## 2. Beam binaries

Releases ship as a zip holding a tar: https://github.com/BeamMW/beam/releases.

```sh
V=7.5.14493; B=https://github.com/BeamMW/beam/releases/download/beam-$V
sudo -u beam mkdir -p /var/lib/beam/node /var/lib/beam/wallet
for p in linux-beam-node linux-beam-wallet-cli linux-wallet-api; do
  curl -sSL -o /tmp/$p.zip $B/$p-$V.zip && unzip -oq /tmp/$p.zip -d /tmp/$p && tar xf /tmp/$p/*.tar -C /tmp/$p
done
sudo install -m 755 /tmp/linux-beam-node/beam-node /var/lib/beam/node/
sudo install -m 755 /tmp/linux-beam-wallet-cli/beam-wallet /tmp/linux-wallet-api/wallet-api /var/lib/beam/wallet/
```

## 3. The wallet (operator only)

The pool's wallet receives the coinbase and pays the miners. Restore or create it yourself; never
hand the seed phrase to a tool. A dedicated wallet for the pool is safer than your main one.

```sh
cd /var/lib/beam/wallet && umask 077
echo '<wallet password>' | sudo -u beam tee wallet.pass >/dev/null && sudo chmod 600 wallet.pass
sudo -u beam ./beam-wallet restore --wallet_path=wallet.db --pass="$(cat wallet.pass)" --seed_phrase="w1;w2;...;w12"
sudo -u beam ./beam-wallet export_miner_key --subkey=1 --pass="$(cat wallet.pass)" --wallet_path=wallet.db   # -> miner key
sudo -u beam ./beam-wallet export_owner_key --pass="$(cat wallet.pass)" --wallet_path=wallet.db               # -> owner key
```

## 4. The node

Stratum needs TLS files and an API key file in one directory:

```sh
sudo -u beam mkdir -p /var/lib/beam/node/secrets && cd /var/lib/beam/node/secrets
sudo -u beam openssl req -x509 -newkey rsa:2048 -nodes -keyout stratum.key -out stratum.crt -subj /CN=beam-node -days 3650
head -c 24 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 32 | sudo -u beam tee stratum.api.keys >/dev/null
sudo chmod 600 stratum.key stratum.api.keys
```

Copy [`pool/deploy/beam-node.cfg`](../pool/deploy/beam-node.cfg) to `/var/lib/beam/node/`, fill
in `miner_key`, `owner_key` and `pass` (the wallet password), `chmod 600`, install
[`beam-node.service`](../pool/deploy/beam-node.service) and start it. Notes:

- `fast_sync=1` downloads headers, then block bodies in packs, then builds the UTXO set:
  about 2.5 hours and 8 GB for mainnet in late 2026. Without it the node fetches every block
  one by one, which takes more than a day. For an archival node that serves history to the
  network set `fast_sync=0` and give it time and disk (the full archive is about 32 GB).
- `mine_online=0`: with the owner wallet connected the node would otherwise wait for it on
  every block template.
- While syncing the node emits a stratum job for every historical block it passes; the pool
  drops those (`sync_lag_blocks`) and miners get no work until the node is at the tip.

## 5. wallet-api

Install [`beam-wallet-api.service`](../pool/deploy/beam-wallet-api.service). It listens on
127.0.0.1:10001 over HTTP; anyone who can reach that port can call `tx_send`, so keep it on
loopback and consider `--use_acl` (put the key in `wallet_api.acl_key`). If the wallet shows
`is_in_sync: false` after a node resync, restart the service.

## 6. The pool

```sh
sudo git clone https://github.com/profinch/bumblebeam /opt/bumblebeam && cd /opt/bumblebeam/pool/server
cargo build --release
sudo install -m 755 target/release/bumblebeam-pool /opt/bumblebeam/bumblebeam-pool
sudo -u beam mkdir -p /etc/bumblebeam/tls && cd /etc/bumblebeam/tls
sudo -u beam openssl req -x509 -newkey rsa:2048 -nodes -keyout pool.key -out pool.crt -subj /CN=bumblebeam -days 3650 -addext "subjectAltName=DNS:<pool host>"
sudo cp /opt/bumblebeam/pool/server/pool.example.toml /etc/bumblebeam/pool.toml   # then edit
```

In `pool.toml`: `node.api_key` is the line from `stratum.api.keys`; `wallet_api.url`
`http://127.0.0.1:10001/api/wallet`; `pool.public_host` the name miners connect to;
`http.web_dir` `/opt/bumblebeam/pool/web`; `database.url_file` `/etc/bumblebeam/database.url`;
`block_check_urls` your own explorer-node first if you run one. Keep `maturity` at 240 or more and
`min_payout_groth` well above the shielded network fee (0.01 BEAM). Install
[`bumblebeam-pool.service`](../pool/deploy/bumblebeam-pool.service) and start it.

Check: `curl -s localhost:8080/api/health` shows `"node": true` once the node is synced and a
template arrived; the web UI is on port 8080; `journalctl -u bumblebeam-pool -f` shows logins and
jobs. The database schema is created and migrated on start; only one pool process may run against
a database.

## 7. Before the first payout

With a little balance in the wallet (0.01 BEAM is enough) run once:

```sh
sudo -u beam /opt/bumblebeam/bumblebeam-pool /etc/bumblebeam/pool.toml admin probe-txid
```

It pays 0.001 BEAM three times to a fresh address of the wallet itself and proves that the wallet
refuses a second `tx_send` with the same transaction id. Only with that proof does the pool resend
interrupted payments automatically; without it they wait for an operator in `review`.

Then run the test suite against a throwaway database (`pool/server/tools/e2e.sh`, see its header)
and a real miner against the TLS port: MXBM, lolMiner and GMiner all default to TLS for Beam.

## 8. Network and firewall

Open to the world: 10000/tcp (node p2p, so the node is a full peer), 3333, 3334, 3443, 3444
(stratum), 443 (web, behind a reverse proxy with a certificate; the pool itself serves plain HTTP
on 8080). Keep closed: 8080, 8101 (node stratum, pool only), 10001 (wallet-api), 5432.

```sh
sudo ufw allow 22/tcp; sudo ufw allow 10000/tcp; sudo ufw allow 3333:3334/tcp; sudo ufw allow 3443:3444/tcp; sudo ufw allow 443/tcp
sudo ufw enable
```

nginx: `proxy_pass http://127.0.0.1:8080;` for `/` with a Let's Encrypt certificate.

## 9. Operations

- `admin list` shows blocks the checks could not settle and payments waiting for a decision;
  `admin block <height> confirm|orphan`, `admin payment <txid> sent|refund` resolve them (see
  [`pool/server/README.md`](../pool/server/README.md)).
- Back up `wallet.db` and `wallet.pass` (the money) and `pg_dump bumblebeam` (balances and
  history). The node database is disposable.
- Update: `git pull`, `cargo build --release`, `install`, `systemctl restart bumblebeam-pool`.
  Schema migrations run on start.
- Shares are kept seven days, hashrate samples 31 (for the month chart); the database stays small.
- Payouts lock a whole UTXO each; split coins with `tx_split` in wallet-api when many miners
  reach the threshold at once.

## Docker

The whole stack as one compose project: the Beam node, wallet-api, PostgreSQL, the pool, the block
explorer (explorer-node and its web UI), and nginx with certbot for the web. This is how pool.bumblebeam.org runs (Debian 13, 4 vCPU, 8 GB RAM, a
separate 300 GB `/data` disk). Files live in [`deploy/docker`](../deploy/docker), which mirrors
`/data/docker` on the server; persistent data lives in `/data/bumblebeam`, owned by uid 10001
(the `beam` user inside the images):

```
/data/docker/                         = deploy/docker
  compose-bumblebeam.yaml             beam-node, wallet-api, postgres, pool, explorer-node, explorer-web, nginx, certbot
  containers/beam/                    node, explorer node, wallet CLI, wallet-api from the release (sha256 pinned,
                                      GPG-checked) and the explorer's contract parser shader
  containers/pool/                    builds bumblebeam-pool from this repository at BUMBLEBEAM_REF
  containers/explorer-web/            builds the explorer UI (explorer/web) at BUMBLEBEAM_REF, nginx
  containers/nginx/, containers/certbot/
  beam-node.cfg.example, explorer-node.cfg.example, pool.toml.example, wallet-setup.sh, .env
/data/bumblebeam/
  node/        node.db, beam-node.cfg, secrets/ (stratum TLS + API key)
  wallet/      wallet.db, wallet.pass                                  <- the money, back it up
  pool/        pool.toml, database.url, tls/                           (mounted at /etc/bumblebeam)
  explorer/    explorer-node's database and explorer-node.cfg
  postgres/    database files;  secrets/postgres.pass
  letsencrypt/ certificates;    logs/
```

| service | network | published |
|---|---|---|
| `beam-node` | `bumblebeam` | `10000` p2p; stratum `8101` stays inside |
| `wallet-api` | `bumblebeam` + internal `bumblebeam-wallet`, fixed `172.30.1.2` | nothing; answers only the pool's `172.30.1.10` |
| `postgres` | `bumblebeam` | nothing |
| `pool` | `bumblebeam` + `bumblebeam-wallet` | `3333-3334`, `3443-3444`; web `127.0.0.1:8080` |
| `explorer-node` | `bumblebeam` | nothing; syncs from `beam-node`, API `8888` stays inside |
| `explorer-web` | `bumblebeam` | `127.0.0.1:8090`; proxies GET `/api/*` to explorer-node, rate-limited |
| `nginx` | host network | `80`, `443`, Cloudflare addresses only (host firewall) |
| `certbot` | default | nothing |

### D1. Docker on the data disk

Keep images and containers off a small root or `/var`. Docker 29 stores images in **containerd**,
so moving Docker's data root alone is not enough:

```sh
sudo systemctl stop docker.socket docker.service containerd.service
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/data-root.conf <<'EOF'
[Service]
ExecStart=
ExecStart=/usr/bin/dockerd --data-root /data/docker/var -H fd:// --containerd=/run/containerd/containerd.sock
EOF
sudo sed -i 's|^#root = "/var/lib/containerd"|root = "/data/docker/containerd"|' /etc/containerd/config.toml
sudo mv /var/lib/docker /data/docker/var; sudo mv /var/lib/containerd /data/docker/containerd
sudo systemctl daemon-reload && sudo systemctl start containerd docker
sudo docker info | grep "Docker Root Dir"
```

Rotate container logs in `/etc/docker/daemon.json`:
`{ "log-driver": "json-file", "log-opts": { "max-size": "100m", "max-file": "5" } }`.

### D2. Firewall

[`deploy/host/nftables.conf`](../deploy/host/nftables.conf) goes to `/etc/nftables.conf`
(`systemctl enable nftables`). It keeps its own table and has no `flush ruleset`, so Docker's rules
survive a reload. Input is dropped except ssh, `10000`, `3333-3334`, `3443-3444`, and `80`/`443`
from Cloudflare's ranges. Docker-published ports go through FORWARD, not INPUT: what compose
publishes is what is open. Apply it over ssh with a way back:

```sh
sudo nft -c -f nftables.conf && sudo systemd-run --on-active=180 /usr/sbin/nft delete table inet host
sudo nft -f nftables.conf      # then open a second ssh session; if it works, stop the timer
```

If the provider filters too (Hetzner Robot firewall), open the same ports there.

### D3. Files and secrets

```sh
sudo git clone https://github.com/profinch/bumblebeam /tmp/bb && sudo cp -a /tmp/bb/deploy/docker/. /data/docker/
B=/data/bumblebeam; umask 077
sudo install -d -m 755 -o 10001 -g 10001 $B $B/node
sudo install -d -m 700 -o 10001 -g 10001 $B/wallet $B/pool $B/pool/tls $B/node/secrets
sudo install -d -m 700 -o 999 -g 999 $B/postgres
sudo install -d -m 755 $B/secrets $B/letsencrypt $B/logs/nginx $B/logs/certbot
sudo install -m 600 -o 10001 -g 10001 /data/docker/beam-node.cfg.example $B/node/beam-node.cfg

PW=$(head -c 48 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 32)
printf %s "$PW" | sudo install -m 600 -o 999 -g 999 /dev/stdin $B/secrets/postgres.pass
printf 'postgres://bumblebeam:%s@postgres:5432/bumblebeam\n' "$PW" | sudo install -m 600 -o 10001 -g 10001 /dev/stdin $B/pool/database.url
KEY=$(head -c 48 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 32)
printf %s "$KEY" | sudo install -m 600 -o 10001 -g 10001 /dev/stdin $B/node/secrets/stratum.api.keys
sed "s|^api_key = .*|api_key = \"$KEY\"|" /data/docker/pool.toml.example | sudo install -m 600 -o 10001 -g 10001 /dev/stdin $B/pool/pool.toml
unset PW KEY
cd /data/docker && sudo docker compose -f compose-bumblebeam.yaml build beam-node
sudo docker run --rm -u 10001:10001 -v $B/node/secrets:/s bumblebeam-beam \
  openssl req -x509 -newkey rsa:2048 -nodes -keyout /s/stratum.key -out /s/stratum.crt -subj /CN=beam-node -days 3650
sudo docker run --rm -u 10001:10001 -v $B/pool/tls:/s bumblebeam-beam \
  openssl req -x509 -newkey rsa:2048 -nodes -keyout /s/pool.key -out /s/pool.crt -subj /CN=stratum.example.org \
  -addext subjectAltName=DNS:stratum.example.org -days 825
```

In `pool.toml` set `public_host` to the stratum name. The template already points at
`beam-node:8101`, at wallet-api on `172.30.1.2` and at `/opt/bumblebeam/web`.

### D4. The node

```sh
cd /data/docker && sudo docker compose -f compose-bumblebeam.yaml up -d beam-node
sudo docker logs -f beam-node          # "Updating node: N% (...)"
```

`beam-node.cfg.example` has `fast_sync=0`: an archival node that keeps and serves the whole history.
Start it first: the sync takes longer than everything else together.

### D5. The wallet (operator only)

```sh
sudo /data/docker/wallet-setup.sh
```

It asks for the seed phrase and a wallet password without echoing them, restores `wallet.db`,
writes `wallet.pass`, and puts the miner key (subkey 1), the owner key and the password into
`beam-node.cfg`, which turns the node's stratum on. Seed and keys stay inside a throwaway
container: not on the screen, not in the shell history, not in a host process list. It refuses to
overwrite an existing `wallet.db`. Then:

```sh
sudo docker compose -f compose-bumblebeam.yaml up -d --force-recreate beam-node wallet-api
```

### D6. The pool

```sh
sudo docker compose -f compose-bumblebeam.yaml build --build-arg BUMBLEBEAM_REF=<commit> pool
sudo docker compose -f compose-bumblebeam.yaml up -d postgres pool
curl -s localhost:8080/api/health
```

Until the node is at the tip the pool logs `node still syncing: no work for miners yet`; that is
expected. Run `admin probe-txid` before the first payout (section 7) with
`sudo docker exec bumblebeam-pool bumblebeam-pool /etc/bumblebeam/pool.toml admin probe-txid`.

### D7. Web and certificates

nginx and certbot are the same as on our other hosts: certbot gets one certificate for
`example.org` and `*.example.org` over Cloudflare DNS-01 at start and daily at 03:00 UTC, and
leaves a trigger; nginx's cron runs `nginx-reload.sh` at 04:00 and reloads when it finds one.
Telegram notices go out when `/data/docker/.env` has `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

1. In Cloudflare: proxied records for the site names, a **DNS-only** record for the stratum name
   (Cloudflare does not carry stratum).
2. An API token: *Edit zone DNS* template plus `Zone · Zone · Read`, the one zone, client IP
   filter = the server's address, no expiry.
3. The token goes into `/data/docker/containers/certbot/config.json` (from `config.example.json`,
   `chmod 600`, git-ignored). Write it there yourself.
4. `sudo docker compose -f compose-bumblebeam.yaml up -d certbot nginx`.

Stratum TLS uses the same certificate (`*.example.org` covers the stratum name). The pool runs as
uid 10001 and reads its certificate at start, so
[`deploy/host/pool-tls-sync.sh`](../deploy/host/pool-tls-sync.sh) copies the live certificate and
key into `/data/bumblebeam/pool/tls/` when they changed and restarts the pool; install it as
`/usr/local/sbin/pool-tls-sync.sh` with `pool-tls-sync.service` and `pool-tls-sync.timer` (daily
04:30 UTC, after the renewal) and `systemctl enable --now pool-tls-sync.timer`. The pool restarts
only on a real renewal; miners reconnect.

[`bumblebeam.conf`](../deploy/docker/containers/nginx/conf/bumblebeam.conf) serves the pool on
`pool.bumblebeam.org`, the explorer on `explorer.bumblebeam.org`, and redirects `bumblebeam.org`
and `www` to the pool.

The explorer: copy `explorer-node.cfg.example` to `/data/bumblebeam/explorer/explorer-node.cfg`
(owned by 10001), then `up -d explorer-node explorer-web`. explorer-node is a second full node with
Beam's HTTP explorer API; it syncs from our archival node over the compose network and decodes
contract calls with the parser shader in the Beam image. To rebuild one service without touching
the running node, use `up -d --no-deps <service>`.

### D8. Operations

- Status: `sudo docker ps`; logs: `sudo docker logs -f beam-node|wallet-api|bumblebeam-pool`. The
  pool logs to the host journal, so its history survives rebuilds:
  `sudo journalctl CONTAINER_NAME=bumblebeam-pool --since "2 hours ago"`. Each miner connection
  leaves a `login` line (with its IP) and a `disconnect` line (minutes, accepted / stale / rejected
  shares, and why it ended); addresses are shortened in logs.
- Pool update: build with the new `BUMBLEBEAM_REF`, then `up -d pool`. Schema migrations run on
  start.
- Beam update: change `BEAM_VERSION` and the three sha256 values in `containers/beam/Dockerfile`
  (check the release's `.asc` signatures first), rebuild, `up -d beam-node wallet-api`.
- Backups: `/data/bumblebeam/wallet` (`wallet.db`, `wallet.pass`) and
  `sudo docker exec bumblebeam-postgres pg_dump -U bumblebeam bumblebeam`. The node database is
  disposable, but an archival resync takes long.
