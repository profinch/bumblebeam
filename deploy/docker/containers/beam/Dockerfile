# Beam node, wallet-api and the wallet CLI from the official release.
# The zips are pinned by sha256; all three were checked against the release's
# GPG signatures (key A6C6 2C9F 5593 1860 AFF8 3BBB 997E AB9F 3DF7 F375,
# security@beam.mw). checksums.txt in the release lists a different hash for
# wallet-api, the signature is what counts.
FROM debian:13-slim AS fetch
ARG BEAM_VERSION=7.5.14493
ARG NODE_SHA256=7cf5edcdd203f1b493d43f6dbdf045c0ec06fb2f02f1e19c9e8c784c49fab16e
ARG WALLET_SHA256=91984c67e418f6e8edaf3966c47f43a578b813ddf4ba4297e9bc2fee78cb3403
ARG WALLET_API_SHA256=02718022aa76e5996965417d0d809e112b0cfa33e17aa16092927252eb517b11
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /fetch
RUN set -e; B=https://github.com/BeamMW/beam/releases/download/beam-$BEAM_VERSION; \
    fetch() { curl -fsSL -o $1.zip $B/$1-$BEAM_VERSION.zip && echo "$2  $1.zip" | sha256sum -c - \
              && unzip -oq $1.zip -d $1 && tar xf $1/*.tar -C $1; }; \
    fetch linux-beam-node "$NODE_SHA256"; \
    fetch linux-beam-wallet-cli "$WALLET_SHA256"; \
    fetch linux-wallet-api "$WALLET_API_SHA256"; \
    install -D -m 755 linux-beam-node/beam-node /out/beam-node; \
    install -D -m 755 linux-beam-wallet-cli/beam-wallet /out/beam-wallet; \
    install -D -m 755 linux-wallet-api/wallet-api /out/wallet-api

FROM debian:13-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 beam && useradd -u 10001 -g beam -d /data -s /usr/sbin/nologin beam
COPY --from=fetch /out/ /usr/local/bin/
USER beam
WORKDIR /data
