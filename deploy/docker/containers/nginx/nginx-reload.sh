#!/bin/bash
set -e

TRIGGER_FILE="/etc/letsencrypt/.nginx-reload"
HOST_HOSTNAME="${HOST_HOSTNAME:-}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"

# Function to send Telegram notification
send_telegram() {
  local status="$1"
  local message="$2"
  if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="${TELEGRAM_CHAT_ID}" \
      -d text="📡 Host: ${HOST_HOSTNAME:-}%0A️🌐 Service: Nginx%0A${status} ${message}" \
      -d parse_mode="HTML" >/dev/null 2>&1 || true
  fi
}

# Check trigger file
if [ ! -f "$TRIGGER_FILE" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S %Z') - INFO: Trigger to reload Nginx not found"
  exit 0
fi

# Check Nginx config
if ! nginx -t 2>/dev/null; then
  MSG="$(date '+%Y-%m-%d %H:%M:%S %Z') - ERROR: Nginx config test failed"
  echo "$MSG"
  send_telegram "🚨" "$MSG"
  exit 1
fi
echo "$(date '+%Y-%m-%d %H:%M:%S %Z') - INFO: Nginx config test passed"

# Run Nginx reload
if nginx -s reload; then
  MSG="$(date '+%Y-%m-%d %H:%M:%S %Z') - INFO: Nginx reloaded successfully"
  echo "$MSG"
  send_telegram "✅" "$MSG"
  rm -f "$TRIGGER_FILE"
else
  MSG="$(date '+%Y-%m-%d %H:%M:%S %Z') - ERROR: Nginx reload failed"
  echo "$MSG"
  send_telegram "🚨" "$MSG"
  exit 1
fi

