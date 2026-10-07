#!/bin/bash
set -e

LOGFILE="/var/log/certbot/renewal.log"

# Create log file
touch $LOGFILE
chmod 0644 $LOGFILE

# Install crontab with expanded variables
echo "$(date '+%Y-%m-%d %H:%M:%S %Z') - INFO: Installing crontab..." | tee -a $LOGFILE
envsubst < /etc/crontabs/root.template > /etc/crontabs/root
chmod 0600 /etc/crontabs/root

echo "$(date '+%Y-%m-%d %H:%M:%S %Z') - INFO: Running initial SSL certificates check..." | tee -a $LOGFILE
/usr/local/bin/certs-renew.sh 2>&1 | tee -a $LOGFILE

echo "$(date '+%Y-%m-%d %H:%M:%S %Z') - INFO: Starting cron daemon..." | tee -a $LOGFILE
echo "$(date '+%Y-%m-%d %H:%M:%S %Z') - INFO: Cron schedule => Daily at 3:00 AM UTC" | tee -a $LOGFILE

exec crond -f

