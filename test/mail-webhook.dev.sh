#!/usr/bin/env bash
# Local smoke test for the mail webhook receiver (no Hostinger needed).
# Real Hostinger deliveries use "Authorization: Bearer <token>" (verified
# Nov 2026); the HMAC signature path is a fallback only.
# Usage: HOSTINGER_WEBHOOK_TOKEN=devtoken bash test/mail-webhook.dev.sh
set -euo pipefail
TOKEN="${HOSTINGER_WEBHOOK_TOKEN:?set HOSTINGER_WEBHOOK_TOKEN first}"
BODY='{"id":"evt_test_001","type":"message.received","mailbox":"documents@mybgctax.com","data":{"messageId":"msg-123"}}'
URL="${API_URL:-http://localhost:4000}/v1/webhooks/mail"

echo "--- valid bearer token (expect 200)"
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "$BODY" "$URL"

echo "--- replay (expect 200, exactly ONE MailEvent row)"
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "$BODY" "$URL"

echo "--- bad token (expect 401)"
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Content-Type: application/json" -H "Authorization: Bearer deadbeef" \
  -d "$BODY" "$URL"

echo "--- no auth header (expect 401)"
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Content-Type: application/json" \
  -d "$BODY" "$URL"

echo "--- missing event id (expect 500 WEBHOOK_MISSING_EVENT_ID)"
NOID='{"type":"message.received"}'
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "$NOID" "$URL"
