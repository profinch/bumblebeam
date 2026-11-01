# The pool's web UI (beam/pool/web) from the public repository at a given ref, served by nginx, so a UI
# change never restarts the pool and its stratum connections. The pool itself answers /api/*.
FROM alpine:3.22 AS src
ARG BUMBLEBEAM_REPO=https://github.com/profinch/bumblebeam
ARG BUMBLEBEAM_REF=main
RUN apk add --no-cache git
RUN git clone "$BUMBLEBEAM_REPO" /src && git -C /src checkout --detach "$BUMBLEBEAM_REF"
# refs from before the beam/ layout (2026-11-01) are moved into it, so a rollback still builds
RUN [ -d /src/beam ] || { mkdir /src/beam; for d in oracle vectors pool explorer; do [ ! -e /src/$d ] || mv /src/$d /src/beam/; done; [ ! -e /src/api ] || mv /src/api /src/beam/explorer/api; }
# version the asset URLs with the commit, so a release never mixes cached and new files
RUN sed -i "s/?v=dev/?v=$(git -C /src rev-parse --short HEAD)/g" /src/beam/pool/web/index.html /src/beam/pool/web/dash.html

FROM nginx:1.28-alpine
COPY --from=src /src/beam/pool/web/ /usr/share/nginx/html/
COPY default.conf /etc/nginx/conf.d/default.conf
