#!/bin/bash
set -e

CONFIG_FILE="/app/config.json"
CREDENTIALS_FILE="/tmp/cloudflare.ini"
RELOAD_TRIGGER="/etc/letsencrypt/.nginx-reload"
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
      -d text="📡 Host: ${HOST_HOSTNAME:-}%0A🔒 Service: Certbot%0A${status} ${message}" \
      -d parse_mode="HTML" >/dev/null 2>&1 || true
  fi
}

echo "=========================================="
echo "Starting certificate renewal process"
echo "Date: $(date)"
echo "=========================================="

# Check if config file exists
if [ ! -f "$CONFIG_FILE" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S %Z') - ERROR: config.json not found at $CONFIG_FILE"
    exit 1
fi

# Parse config.json
CF_API_TOKEN=$(jq -r '.cloudflare.api_token' "$CONFIG_FILE")
CERTBOT_EMAIL=$(jq -r '.certbot.email' "$CONFIG_FILE")

# Validate required fields
if [ -z "$CF_API_TOKEN" ] || [ "$CF_API_TOKEN" = "null" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S %Z') - ERROR: cloudflare.api_token not found in config"
    exit 1
fi

if [ -z "$CERTBOT_EMAIL" ] || [ "$CERTBOT_EMAIL" = "null" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S %Z') - ERROR: certbot.email not found in config"
    exit 1
fi

# Create Cloudflare credentials file
cat > "$CREDENTIALS_FILE" << EOF
# Cloudflare API token
dns_cloudflare_api_token = $CF_API_TOKEN
EOF

chmod 0600 "$CREDENTIALS_FILE"

# Get number of domains
DOMAIN_COUNT=$(jq '.domains | length' "$CONFIG_FILE")

echo "Found $DOMAIN_COUNT domain(s) to process"
echo ""

# Track certificates status
CERTS_UPDATED=false
RENEWED_DOMAINS=()
FAILED_DOMAINS=()

# Loop through each domain
for i in $(seq 0 $((DOMAIN_COUNT - 1))); do
  BASE_DOMAIN=$(jq -r ".domains[$i].domain" "$CONFIG_FILE")
  IS_WILDCARD=$(jq -r "if .domains[$i].wildcard == false then \"false\" else \"true\" end" "$CONFIG_FILE")
  IS_ENABLED=$(jq -r "if .domains[$i].enabled == false then \"false\" else \"true\" end" "$CONFIG_FILE")

  # Derive DOMAIN from wildcard flag
  if [ "$IS_WILDCARD" = "true" ]; then
    DOMAIN="*.${BASE_DOMAIN}"
  else
    DOMAIN="$BASE_DOMAIN"
  fi

  # Check for domain-specific email, fallback to global email
  DOMAIN_EMAIL=$(jq -r ".domains[$i].email // empty" "$CONFIG_FILE")
  if [ -n "$DOMAIN_EMAIL" ] && [ "$DOMAIN_EMAIL" != "null" ]; then
    EMAIL_TO_USE="$DOMAIN_EMAIL"
    echo "Processing: $DOMAIN (wildcard: $IS_WILDCARD, email: $EMAIL_TO_USE)"
  else
    EMAIL_TO_USE="$CERTBOT_EMAIL"
    echo "Processing: $DOMAIN (wildcard: $IS_WILDCARD, email: $EMAIL_TO_USE [default])"
  fi

  # Skip disabled domains
  if [ "$IS_ENABLED" = "false" ]; then
    echo "⏭ Skipping $DOMAIN (disabled)"
    echo ""
    continue
  fi

  # Pre-validate: check domain exists in Cloudflare
  echo "Checking $BASE_DOMAIN in Cloudflare..."
  CF_ZONE=$(curl -s -X GET "https://api.cloudflare.com/client/v4/zones?name=$BASE_DOMAIN" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    | jq -r '.result[0].id // empty')

  if [ -z "$CF_ZONE" ]; then
    MSG="$(date '+%Y-%m-%d %H:%M:%S %Z') - ERROR: $BASE_DOMAIN not found in Cloudflare, skipping"
    echo "⚠ $MSG"
    FAILED_DOMAINS+=("$DOMAIN")
    echo ""
    continue
  fi
  echo "✓ $BASE_DOMAIN found in Cloudflare (zone: $CF_ZONE)"

  # Common certbot arguments
  CERTBOT_ARGS=(
    "certbot" "certonly"
    "--dns-cloudflare"
    "--dns-cloudflare-credentials" "$CREDENTIALS_FILE"
    "--email" "$EMAIL_TO_USE"
    "--agree-tos"
    "--non-interactive"
    "--dns-cloudflare-propagation-seconds" "30"
    "--key-type" "ecdsa"
    "--elliptic-curve" "secp384r1"
    "--deploy-hook" "touch $RELOAD_TRIGGER"
  )

  # Run certbot with appropriate domain arguments
  if [ "$IS_WILDCARD" = "true" ]; then
    echo "Requesting certificate for $DOMAIN and $BASE_DOMAIN"
    OUTPUT=$(timeout 120 "${CERTBOT_ARGS[@]}" \
      --expand \
      -d "$DOMAIN" \
      -d "$BASE_DOMAIN" 2>&1)
    EXIT_CODE=$?
  else
    echo "Requesting certificate for $DOMAIN"
    OUTPUT=$(timeout 120 "${CERTBOT_ARGS[@]}" \
      -d "$DOMAIN" 2>&1)
    EXIT_CODE=$?
  fi

  # Evaluate result
  if [ $EXIT_CODE -eq 124 ]; then
    MSG="$(date '+%Y-%m-%d %H:%M:%S %Z') - ERROR: Timed out renewing certificate for $DOMAIN"
    echo "⚠ $MSG"
    FAILED_DOMAINS+=("$DOMAIN")
    send_telegram "🚨" "$MSG"
  elif echo "$OUTPUT" | grep -q "Certificate not yet due for renewal"; then
    echo "✓ Successfully processed $DOMAIN (not due for renewal)"
  elif echo "$OUTPUT" | grep -q "Successfully received certificate"; then
    MSG="$(date '+%Y-%m-%d %H:%M:%S %Z') - INFO: Certificate renewed for $DOMAIN"
    echo "✓ $MSG"
    CERTS_UPDATED=true
    RENEWED_DOMAINS+=("$DOMAIN")
    send_telegram "✅" "$MSG"
  else
    MSG="$(date '+%Y-%m-%d %H:%M:%S %Z') - ERROR: Failed to renew certificate for $DOMAIN"
    echo "$MSG"
    FAILED_DOMAINS+=("$DOMAIN")
    send_telegram "🚨" "$MSG"
  fi

  echo ""
done

# Clean up credentials file
rm -f "$CREDENTIALS_FILE"

echo "=========================================="
echo "Certificate renewal process completed"
echo "Date: $(date)"
echo "Certificates updated: $CERTS_UPDATED"
echo "=========================================="
echo ""

# List all certificates
echo "Current certificates:"
certbot certificates

# Show reload trigger status
if [ -f "$RELOAD_TRIGGER" ]; then
    echo ""
    echo "$(date '+%Y-%m-%d %H:%M:%S %Z') - INFO: Nginx reload trigger created at: $RELOAD_TRIGGER"
fi

