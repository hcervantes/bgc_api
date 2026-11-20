import { MailIntakeWorkerService } from './mail-intake.worker';
import type { MailEvent } from '@prisma/client';

// Plain-jest unit tests (no @nestjs/testing): constructor-injected fakes.

const realEnvelope = {
  id: '030aa39d-1111-7abc-8def-0123456789ab',
  event: 'message.received',
  timestamp: '2026-11-20T03:04:51.978Z',
  data: {
    from: 'Hector Cervantes <someone@example.com>',
    mailboxAddress: 'documents@mybgctax.com',
    messageId: '<abc@example.com>',
    subject: 'W2 2025',
    attachments: [{ fileUrl: 'https://storage.googleapis.com/x', filename: 'sample_W2.pdf', sizeBytes: 2897, contentType: 'application/pdf' }],
  },
};

const mkEvent = (over: Partial<MailEvent> = {}): MailEvent =>
  ({
    id: 'row1',
    eventId: '030aa39d-1111-7abc-8def-0123456789ab',
    eventType: 'message.received',
    mailbox: 'documents@mybgctax.com',
    messageId: '<abc@example.com>',
    rawPayload: realEnvelope,
    status: 'PENDING',
    receivedAt: new Date(),
    processedAt: null,
    error: null,
    ...over,
  }) as MailEvent;

const mkSvc = (f: any) =>
  new MailIntakeWorkerService(f.prisma, f.config, f.mailApi, f.spaces, f.clamav);

const happy = () => ({
  prisma: {
    client: { findFirst: jest.fn().mockResolvedValue({ id: 'c1', slug: 'acme' }) },
    mailEvent: { update: jest.fn().mockResolvedValue({}), delete: jest.fn().mockResolvedValue({}) },
  },
  config: { get: jest.fn().mockReturnValue('bgc-tax-documents') },
  mailApi: { downloadSigned: jest.fn().mockResolvedValue(Buffer.from('pdf bytes')) },
  spaces: { putObject: jest.fn().mockResolvedValue(undefined) },
  clamav: { scan: jest.fn().mockResolvedValue({ ok: true }) },
});

describe('MailIntakeWorkerService.process', () => {
  it('downloads, scans and stages each attachment, then marks PROCESSED', async () => {
    const f = happy();
    await mkSvc(f).process(mkEvent());
    expect(f.mailApi.downloadSigned).toHaveBeenCalledWith('https://storage.googleapis.com/x');
    expect(f.spaces.putObject).toHaveBeenCalledWith(
      'bgc-tax-documents',
      'acme/mail-staging/030aa39d-1111-7abc-8def-0123456789ab/sample_W2.pdf',
      expect.any(Buffer),
      'application/pdf',
    );
    expect(f.prisma.mailEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PROCESSED' }) }),
    );
    expect(f.prisma.mailEvent.delete).not.toHaveBeenCalled();
  });

  it('extracts the address from "Name <addr>" for the exact client match', async () => {
    const f = happy();
    await mkSvc(f).process(mkEvent());
    expect(f.prisma.client.findFirst).toHaveBeenCalledWith({ where: { email: 'someone@example.com' }, select: { id: true, slug: true } });
  });

  it('marks PROCESSED with zero attachments staged when none are present', async () => {
    const f = happy();
    const ev = mkEvent({ rawPayload: { ...realEnvelope, data: { ...realEnvelope.data, attachments: [] } } });
    await mkSvc(f).process(ev);
    expect(f.mailApi.downloadSigned).not.toHaveBeenCalled();
    expect(f.prisma.mailEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PROCESSED' }) }),
    );
  });

  it('marks FAILED (keeps row) on unknown sender', async () => {
    const f = happy();
    f.prisma.client.findFirst = jest.fn().mockResolvedValue(null);
    await mkSvc(f).process(mkEvent());
    expect(f.prisma.mailEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', error: expect.stringContaining('NO_MATCHING_CLIENT') }),
      }),
    );
  });

  it('marks FAILED on AV infection and does not stage that attachment', async () => {
    const f = happy();
    f.clamav.scan = jest.fn().mockResolvedValue({ ok: false, signature: 'EICAR' });
    await mkSvc(f).process(mkEvent());
    expect(f.spaces.putObject).not.toHaveBeenCalled();
    expect(f.prisma.mailEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', error: expect.stringContaining('AV_INFECTED') }),
      }),
    );
  });

  it('deletes the row and rethrows on signed-URL download failure', async () => {
    const f = happy();
    f.mailApi.downloadSigned = jest.fn().mockRejectedValue(new Error('DOWNLOAD_HTTP_403'));
    await expect(mkSvc(f).process(mkEvent())).rejects.toThrow('MAIL_INTAKE_TRANSIENT');
    expect(f.prisma.mailEvent.delete).toHaveBeenCalledWith({ where: { id: 'row1' } });
  });

  it('deletes the row and rethrows on clamd outage', async () => {
    const f = happy();
    f.clamav.scan = jest.fn().mockRejectedValue(new Error('CLAMD_UNREACHABLE'));
    await expect(mkSvc(f).process(mkEvent())).rejects.toThrow('MAIL_INTAKE_TRANSIENT');
    expect(f.prisma.mailEvent.delete).toHaveBeenCalled();
  });

  it('sanitizes attachment filenames in the staging key', async () => {
    const f = happy();
    const ev = mkEvent({
      rawPayload: { ...realEnvelope, data: { ...realEnvelope.data, attachments: [{ fileUrl: 'u', filename: 'evil/../name with spaces.pdf' }] } },
    });
    await mkSvc(f).process(ev);
    expect(f.spaces.putObject).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringMatching(/acme\/mail-staging\/.+\/evil_name_with_spaces\.pdf$/),
      expect.any(Buffer),
      'application/octet-stream',
    );
  });

  it('is a no-op for non message.received event types', async () => {
    const f = happy();
    await mkSvc(f).process(mkEvent({ eventType: 'something.else' }));
    expect(f.mailApi.downloadSigned).not.toHaveBeenCalled();
  });
});
