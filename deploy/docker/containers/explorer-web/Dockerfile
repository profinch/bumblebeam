# BumbleBeam Explorer: the static UI plus the shared ui/ library and the pool's icons, served by nginx, which also
# proxies the read-only explorer API. Built by CI from the repository root:
#   docker build -f deploy/docker/containers/explorer-web/Dockerfile --build-arg VERSION=<v> .
FROM nginx:1.28-alpine
ARG VERSION=dev
COPY beam/explorer/web/ /usr/share/nginx/html/
COPY ui/ /usr/share/nginx/html/ui/
COPY beam/pool/web/favicon.svg beam/pool/web/404.svg /usr/share/nginx/html/
RUN sed -i "s/?v=dev/?v=${VERSION}/g" /usr/share/nginx/html/index.html
COPY deploy/docker/containers/explorer-web/default.conf /etc/nginx/conf.d/default.conf
