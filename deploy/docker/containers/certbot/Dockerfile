FROM certbot/dns-cloudflare:v4.1.1

# Install required packages
RUN apk add --no-cache \
    cronie \
    bash \
    jq \
    gettext \
    curl

# Create log directory
RUN mkdir -p /var/log/certbot

# Configure cron jobs (as template for envsubst)
COPY crontab /etc/crontabs/root.template

# Copy SSL certificates renew script
COPY certs-renew.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/certs-renew.sh

# Copy entrypoint script
COPY docker-entrypoint.sh /
RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]

