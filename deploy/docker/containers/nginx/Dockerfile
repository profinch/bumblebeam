FROM nginx:1.28

# Install required packages
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    cron \
    logrotate \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Configure cron jobs
COPY crontab /etc/cron.d/nginx
RUN chmod 0644 /etc/cron.d/nginx

# Configure logrotate
COPY logrotate.conf /etc/logrotate.d/nginx
RUN chmod 0644 /etc/logrotate.d/nginx

# Copy Nginx reload script
COPY nginx-reload.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/nginx-reload.sh

# Copy entrypoint script
COPY docker-entrypoint.sh /
RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]

