#!/usr/bin/env bash
# Local smoke test for the mail webhook receiver (no Hostinger needed).
# Usage: HOSTINGER_WEBHOOK_SECRET=devsecret bash test/mail-webhook.dev.sh
set -euo pipefail
SECRET="${HOSTINGER_WEBHOOK_SECRET:?set HOSTINGER_WEBHOOK_SECRET first}"
BODY='{"id":"evt_test_001","type":"message.received","mailbox":"documents@mybgctax.com","data":{"messageId":"msg-123"}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')
URL="${API_URL:-http://localhost:4000}/v1/webhooks/mail"

echo "--- valid signature (expect 200)"
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Content-Type: application/json" -H "x-webhook-signature: $SIG" \
  -d "$BODY" "$URL"

echo "--- replay (expect 200, exactly ONE MailEvent row)"
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Content-Type: application/json" -H "x-webhook-signature: $SIG" \
  -d "$BODY" "$URL"

echo "--- bad signature (expect 401)"
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Content-Type: application/json" -H "x-webhook-signature: deadbeef" \
  -d "$BODY" "$URL"

echo "--- missing event id (expect 500 WEBHOOK_MISSING_EVENT_ID)"
NOID='{"type":"message.received"}'
SIG2=$(printf '%s' "$NOID" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Content-Type: application/json" -H "x-webhook-signature: $SIG2" \
  -d "$NOID" "$URL"
