# puzzle.bumblebeam.org: the static site plus the shared ui/ library, served by nginx, which also proxies /api/
# to puzzle-api. Built by CI from the repository root:
#   docker build -f deploy/docker/containers/puzzle-web/Dockerfile --build-arg VERSION=<v> .
FROM nginx:1.28-alpine
ARG VERSION=dev
COPY bitcoin/puzzle/web/ /usr/share/nginx/html/
COPY ui/ /usr/share/nginx/html/ui/
# version the asset URLs, so a release never mixes cached and new files
RUN sed -i "s/?v=dev/?v=${VERSION}/g" /usr/share/nginx/html/index.html
COPY deploy/docker/containers/puzzle-web/default.conf /etc/nginx/conf.d/default.conf
