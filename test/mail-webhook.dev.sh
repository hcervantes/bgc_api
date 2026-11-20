#!/usr/bin/env bash
# Local smoke test for the mail webhook receiver (no Hostinger needed).
# Envelope shape matches VERIFIED live Hostinger deliveries (Nov 2026):
#   { id, event, timestamp, data: { from, mailboxAddress, attachments[] } }
# NOTE: with the intake worker enabled locally, message.received events are
# processed inline — from addresses that match no Client.email end as a
# FAILED row (kept). Use a from-address that matches a seeded client for the
# happy path, or expect FAILED / NO_MATCHING_CLIENT in the console.
# Usage: HOSTINGER_WEBHOOK_TOKEN=devtoken bash test/mail-webhook.dev.sh
set -euo pipefail
TOKEN="${HOSTINGER_WEBHOOK_TOKEN:?set HOSTINGER_WEBHOOK_TOKEN first}"
FROM="${TEST_FROM_ADDRESS:-sender@example.com}"
BODY="{\"id\":\"evt_test_001\",\"event\":\"message.received\",\"timestamp\":\"2026-11-20T00:00:00Z\",\"data\":{\"from\":\"Test Sender <$FROM>\",\"mailboxAddress\":\"documents@mybgctax.com\",\"messageId\":\"<test-123>\",\"subject\":\"smoke\",\"attachments\":[]}}"
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
NOID='{"event":"message.received","data":{"from":"x@y.z"}}'
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "$NOID" "$URL"
