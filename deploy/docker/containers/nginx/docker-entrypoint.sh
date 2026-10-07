#!/bin/sh
set -e

LOGFILE="/var/log/nginx/cron.log"

# Create cron logs file
touch $LOGFILE
chmod 0644 $LOGFILE

# Install crontab with expanded variables
echo "$(date '+%Y-%m-%d %H:%M:%S %Z') - INFO: Installing crontab..." | tee -a $LOGFILE
envsubst < /etc/cron.d/nginx | crontab -

# Start cron daemon
echo "$(date '+%Y-%m-%d %H:%M:%S %Z') - INFO: Starting cron daemon..." | tee -a $LOGFILE
service cron start >/dev/null 2>&1

if pidof cron >/dev/null 2>&1; then
  echo "$(date '+%Y-%m-%d %H:%M:%S %Z') - INFO: Cron started successfully (PID: $(pidof cron))" | tee -a $LOGFILE
else
  echo "$(date '+%Y-%m-%d %H:%M:%S %Z') - ERROR: Failed to start cron" | tee -a $LOGFILE >&2
fi

# Forward control to exec
exec "$@"

