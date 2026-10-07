# bumblebeam-pool built from the public repository at a given ref.
# The oracle (C++) is compiled into the binary by build.rs, hence g++.
FROM rust:1-slim-trixie AS build
ARG BUMBLEBEAM_REPO=https://github.com/profinch/bumblebeam
ARG BUMBLEBEAM_REF=main
RUN apt-get update && apt-get install -y --no-install-recommends git g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone "$BUMBLEBEAM_REPO" /src && git -C /src checkout --detach "$BUMBLEBEAM_REF"
# Version the UI's asset URLs with the commit, so browsers and Cloudflare fetch new files on release
RUN sed -i "s/?v=dev/?v=$(git -C /src rev-parse --short HEAD)/g" /src/pool/web/index.html
WORKDIR /src/pool/server
RUN cargo build --release

FROM debian:13-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 beam && useradd -u 10001 -g beam -d /etc/bumblebeam -s /usr/sbin/nologin beam
COPY --from=build /src/pool/server/target/release/bumblebeam-pool /usr/local/bin/
COPY --from=build /src/pool/web /opt/bumblebeam/web
USER beam
WORKDIR /etc/bumblebeam
ENV RUST_LOG=info
ENTRYPOINT ["bumblebeam-pool", "/etc/bumblebeam/pool.toml"]
