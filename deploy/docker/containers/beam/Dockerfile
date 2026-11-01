# Beam node, explorer node, wallet-api and the wallet CLI from the official release.
# The zips are pinned by sha256; all three were checked against the release's
# GPG signatures (key A6C6 2C9F 5593 1860 AFF8 3BBB 997E AB9F 3DF7 F375,
# security@beam.mw). checksums.txt in the release lists a different hash for
# wallet-api, the signature is what counts. explorer-node matches checksums.txt.
FROM debian:13-slim AS fetch
ARG BEAM_VERSION=7.5.14548
ARG NODE_SHA256=8bfa80ddddf23e8fe4abb0d55fc6d95acb26be82dd64316a49473cf9a0bbd0d3
ARG WALLET_SHA256=c39dc995ff45d58d65809b830c53c1cf34f9a1ec51aae872084eb47e29c312e7
ARG WALLET_API_SHA256=2416ef739492df279cd9580fbde01caf546bd63b699439b9c0d03e0bb8a34e5f
ARG EXPLORER_SHA256=4ae4c74f556f5ced67c9cedfc52519f70586a97d8ce588009b4f1a85500650b2
# The explorer's contract parser shader (decodes contract calls and state), from the same tag.
ARG PARSER_SHA256=3f48697cabbfb959dd80a94c0a5709d128c6cedf7c7acb45f20f17f09398ad18
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /fetch
RUN set -e; B=https://github.com/BeamMW/beam/releases/download/beam-$BEAM_VERSION; \
    fetch() { curl -fsSL -o $1.zip $B/$1-$BEAM_VERSION.zip && echo "$2  $1.zip" | sha256sum -c - \
              && unzip -oq $1.zip -d $1 && tar xf $1/*.tar -C $1; }; \
    fetch linux-beam-node "$NODE_SHA256"; \
    fetch linux-beam-wallet-cli "$WALLET_SHA256"; \
    fetch linux-wallet-api "$WALLET_API_SHA256"; \
    fetch linux-explorer-node "$EXPLORER_SHA256"; \
    install -D -m 755 linux-beam-node/beam-node /out/beam-node; \
    install -D -m 755 linux-beam-wallet-cli/beam-wallet /out/beam-wallet; \
    install -D -m 755 linux-wallet-api/wallet-api /out/wallet-api; \
    install -D -m 755 linux-explorer-node/explorer-node /out/explorer-node; \
    curl -fsSL -o Parser.wasm https://raw.githubusercontent.com/BeamMW/beam/beam-$BEAM_VERSION/bvm/Shaders/Explorer/Parser.wasm; \
    echo "$PARSER_SHA256  Parser.wasm" | sha256sum -c -; \
    install -D -m 644 Parser.wasm /out/share/Parser.wasm

FROM debian:13-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 beam && useradd -u 10001 -g beam -d /data -s /usr/sbin/nologin beam
COPY --from=fetch /out/beam-node /out/beam-wallet /out/wallet-api /out/explorer-node /usr/local/bin/
COPY --from=fetch /out/share/Parser.wasm /usr/local/share/beam/Parser.wasm
USER beam
WORKDIR /data
