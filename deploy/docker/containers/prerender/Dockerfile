# Prerendered pages for pool-web and explorer-web: headless Chromium opens each indexable page
# through the host nginx, lets app.js fill it, and saves the HTML into /snap, which pool-web and
# explorer-web serve to every visitor (search engines and AI crawlers that run no JavaScript
# included). app.js then keeps the page live as before. See prerender.sh.
FROM alpine:3.22
RUN apk add --no-cache bash chromium coreutils curl findutils jq \
 && adduser -D -u 10001 prerender
COPY prerender.sh /usr/local/bin/prerender.sh
USER prerender
ENTRYPOINT ["/usr/local/bin/prerender.sh"]
