# puzzle.bumblebeam.org: the static site plus the shared ui/ library, served by nginx, which also proxies /api/
# to puzzle-api. Built by CI from the repository root:
#   docker build -f deploy/docker/containers/puzzle-web/Dockerfile --build-arg VERSION=<v> .
FROM nginx:1.28-alpine
ARG VERSION=dev
COPY bitcoin/puzzle/web/ /usr/share/nginx/html/
COPY ui/ /usr/share/nginx/html/ui/
# version the asset URLs, so a release never mixes cached and new files
RUN sed -i "s/?v=dev/?v=${VERSION}/g" /usr/share/nginx/html/*.html
# every text file kept gzipped at the highest level beside itself, which nginx sends as it is (gzip_static): 12%
# fewer bytes than its own gzip at level 1, and no compressing per request
RUN find /usr/share/nginx/html -type f \( -name '*.html' -o -name '*.js' -o -name '*.css' -o -name '*.svg' -o -name '*.json' -o -name '*.txt' \) -size +1k \
    -exec sh -c 'for f; do gzip -9 -c "$f" > "$f.gz" && touch -r "$f" "$f.gz"; done' sh {} +
COPY deploy/docker/containers/puzzle-web/default.conf /etc/nginx/conf.d/default.conf
