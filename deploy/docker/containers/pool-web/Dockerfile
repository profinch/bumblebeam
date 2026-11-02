# The pool's web UI (beam/pool/web), served by nginx, built by CI from the repository root:
#   docker build -f deploy/docker/containers/pool-web/Dockerfile --build-arg VERSION=<v> .
# A UI change never restarts the pool and its stratum connections; the pool itself answers /api/*.
FROM nginx:1.28-alpine
ARG VERSION=dev
COPY beam/pool/web/ /usr/share/nginx/html/
# the shared look (tokens, components, tooltips): ui/ in the repo root, served at /ui/
COPY ui/ /usr/share/nginx/html/ui/
# version the asset URLs, so a release never mixes cached and new files
RUN sed -i "s/?v=dev/?v=${VERSION}/g" /usr/share/nginx/html/index.html /usr/share/nginx/html/dash.html
COPY deploy/docker/containers/pool-web/default.conf /etc/nginx/conf.d/default.conf
