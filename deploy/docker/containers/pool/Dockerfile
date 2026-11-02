# bumblebeam-pool, built by CI (.github/workflows/images.yml) from the repository root:
#   docker build -f deploy/docker/containers/pool/Dockerfile .
# The oracle (C++) is compiled into the binary by build.rs, hence g++.
FROM rust:1-slim-trixie AS build
RUN apt-get update && apt-get install -y --no-install-recommends g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY beam/oracle /src/beam/oracle
COPY beam/vectors /src/beam/vectors
COPY beam/pool/server /src/beam/pool/server
WORKDIR /src/beam/pool/server
# Cargo.lock is committed: the same commit builds the same binary
RUN cargo build --release --locked

FROM debian:13-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 beam && useradd -u 10001 -g beam -d /etc/bumblebeam -s /usr/sbin/nologin beam
COPY --from=build /src/beam/pool/server/target/release/bumblebeam-pool /usr/local/bin/
USER beam
WORKDIR /etc/bumblebeam
ENV RUST_LOG=info,tokio_postgres=warn
# the role comes from compose's command: none = both halves, `run stratum` / `run app` = one half (beam/pool/docs/pool-split.md)
ENTRYPOINT ["bumblebeam-pool", "/etc/bumblebeam/pool.toml"]
