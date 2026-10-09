# The pool's web UI (pool/web) from the public repository at a given ref, served by nginx, so a UI
# change never restarts the pool and its stratum connections. The pool itself answers /api/*.
FROM alpine:3.22 AS src
ARG BUMBLEBEAM_REPO=https://github.com/profinch/bumblebeam
ARG BUMBLEBEAM_REF=main
RUN apk add --no-cache git
RUN git clone "$BUMBLEBEAM_REPO" /src && git -C /src checkout --detach "$BUMBLEBEAM_REF"
# version the asset URLs with the commit, so a release never mixes cached and new files
RUN sed -i "s/?v=dev/?v=$(git -C /src rev-parse --short HEAD)/g" /src/pool/web/index.html /src/pool/web/admin.html

FROM nginx:1.28-alpine
COPY --from=src /src/pool/web/ /usr/share/nginx/html/
COPY default.conf /etc/nginx/conf.d/default.conf
