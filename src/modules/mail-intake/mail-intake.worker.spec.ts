import { MailIntakeWorkerService } from './mail-intake.worker';
import type { MailEvent } from '@prisma/client';

// Plain-jest unit tests (no @nestjs/testing dependency): fakes injected
// through the constructor.

const mkEvent = (over: Partial<MailEvent> = {}): MailEvent =>
  ({
    id: 'row1',
    eventId: 'evt_1',
    eventType: 'message.received',
    mailbox: 'documents@mybgctax.com',
    messageId: 'msg-1',
    rawPayload: {},
    status: 'PENDING',
    receivedAt: new Date(),
    processedAt: null,
    error: null,
    ...over,
  }) as MailEvent;

const mkSvc = (fakes: any) =>
  new MailIntakeWorkerService(fakes.prisma, fakes.config, fakes.mailApi, fakes.spaces, fakes.clamav);

const happy = () => ({
  prisma: {
    client: { findFirst: jest.fn().mockResolvedValue({ id: 'c1', slug: 'acme' }) },
    mailEvent: {
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
  },
  config: { get: jest.fn().mockReturnValue('bgc-tax-documents') },
  mailApi: { fetchMessage: jest.fn().mockResolvedValue({ raw: Buffer.from('x'), from: 'a@acme.com' }) },
  spaces: { putObject: jest.fn().mockResolvedValue(undefined) },
  clamav: { scan: jest.fn().mockResolvedValue({ ok: true }) },
});

describe('MailIntakeWorkerService.process', () => {
  it('stages to Spaces and marks PROCESSED on the happy path', async () => {
    const f = happy();
    await mkSvc(f).process(mkEvent());
    expect(f.spaces.putObject).toHaveBeenCalledWith(
      'bgc-tax-documents',
      'acme/mail-staging/msg-1.eml',
      expect.any(Buffer),
      'message/rfc822',
    );
    expect(f.prisma.mailEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PROCESSED' }) }),
    );
    expect(f.prisma.mailEvent.delete).not.toHaveBeenCalled();
  });

  it('marks FAILED (keeps row, 200 to Hostinger) on unknown sender', async () => {
    const f = happy();
    f.prisma.client.findFirst = jest.fn().mockResolvedValue(null);
    await mkSvc(f).process(mkEvent());
    expect(f.prisma.mailEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', error: expect.stringContaining('NO_MATCHING_CLIENT') }),
      }),
    );
  });

  it('marks FAILED on AV infection and does not stage to Spaces', async () => {
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

  it('deletes the row and rethrows on clamd outage (Hostinger retry reprocesses)', async () => {
    const f = happy();
    f.clamav.scan = jest.fn().mockRejectedValue(new Error('CLAMD_UNREACHABLE'));
    await expect(mkSvc(f).process(mkEvent())).rejects.toThrow('MAIL_INTAKE_TRANSIENT');
    expect(f.prisma.mailEvent.delete).toHaveBeenCalledWith({ where: { id: 'row1' } });
  });

  it('deletes the row and rethrows on Mail API failure', async () => {
    const f = happy();
    f.mailApi.fetchMessage = jest.fn().mockRejectedValue(new Error('MAIL_API_HTTP_503'));
    await expect(mkSvc(f).process(mkEvent())).rejects.toThrow('MAIL_INTAKE_TRANSIENT');
    expect(f.prisma.mailEvent.delete).toHaveBeenCalled();
  });

  it('is a no-op for non message.received event types', async () => {
    const f = happy();
    await mkSvc(f).process(mkEvent({ eventType: 'bounce' }));
    expect(f.mailApi.fetchMessage).not.toHaveBeenCalled();
  });
});
