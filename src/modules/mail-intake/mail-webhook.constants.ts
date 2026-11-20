// Header carrying an HMAC signature, IF Hostinger ever adds signed
// delivery. VERIFIED Nov 2026: real Hostinger Mail webhooks authenticate with
// "Authorization: Bearer <token>" (see verifyBearerToken) and send
// x-correlation-id for tracing; there is NO signature header.
export const MAIL_WEBHOOK_SIGNATURE_HEADER =
  process.env.MAIL_WEBHOOK_SIGNATURE_HEADER ?? 'x-webhook-signature';

export const MAIL_EVENT_TYPES = {
  MESSAGE_RECEIVED: 'message.received',
} as const;
