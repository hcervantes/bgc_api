// Header carrying the HMAC signature. VERIFY the exact header name against a
// real Hostinger delivery (hPanel → Agentic Mail → Webhooks → Recent
// deliveries shows the outgoing request) and adjust here or via
// MAIL_WEBHOOK_SIGNATURE_HEADER if it differs.
export const MAIL_WEBHOOK_SIGNATURE_HEADER =
  process.env.MAIL_WEBHOOK_SIGNATURE_HEADER ?? 'x-webhook-signature';

export const MAIL_EVENT_TYPES = {
  MESSAGE_RECEIVED: 'message.received',
} as const;
