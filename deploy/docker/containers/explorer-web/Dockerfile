# BumbleBeam Explorer: the static UI from the public repository at a given ref, plus the pool's
# stylesheet and icon, served by nginx, which also proxies the read-only explorer API.
FROM alpine:3.22 AS src
ARG BUMBLEBEAM_REPO=https://github.com/profinch/bumblebeam
ARG BUMBLEBEAM_REF=main
RUN apk add --no-cache git
RUN git clone "$BUMBLEBEAM_REPO" /src && git -C /src checkout --detach "$BUMBLEBEAM_REF"
# version the asset URLs with the commit, so a release never mixes cached and new files
RUN sed -i "s/?v=dev/?v=$(git -C /src rev-parse --short HEAD)/g" /src/explorer/web/index.html

FROM nginx:1.28-alpine
COPY --from=src /src/explorer/web/ /usr/share/nginx/html/
COPY --from=src /src/pool/web/styles.css /src/pool/web/favicon.svg /usr/share/nginx/html/
COPY default.conf /etc/nginx/conf.d/default.conf
