import { Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { TenantGuard } from '../../common/tenancy/tenant.guard';
import { RunReportDto } from './reports-query.dto';
import { ReportsService } from './reports.service';

/**
 * Phase 4.3 — tenant-scoped Books Reports tab endpoints.
 * The tenant Company comes ONLY from the session's Client row
 * (TenantGuard); the report key is whitelisted in ReportsService,
 * so no company/report name is ever taken from the wire.
 */
@Controller('clients/:clientId/books/reports')
@UseGuards(JwtAuthGuard, TenantGuard)
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

  /** The report catalog for the Reports tab UI. */
  @Get()
  catalog() {
    return this.service.catalog();
  }

  /** CSV download — declared BEFORE :reportKey so it is not swallowed
   *  by the catch-all route. */
  @Get(':reportKey/download')
  async download(
    @Req() req: Request,
    @Param('reportKey') reportKey: string,
    @Query() dto: RunReportDto,
    @Res() res: Response,
  ) {
    const result = await this.service.runReport(req.tenant as { clientId: string }, reportKey, dto);
    const csv = this.service.toCsv(result);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="' + result.key + '_' + result.fromDate + '_' + result.toDate + '.csv"',
    );
    res.send(csv);
  }

  /** Run a report — returns { key, title, fromDate, toDate, columns, rows }. */
  @Get(':reportKey')
  run(
    @Req() req: Request,
    @Param('reportKey') reportKey: string,
    @Query() dto: RunReportDto,
  ) {
    return this.service.runReport(req.tenant as { clientId: string }, reportKey, dto);
  }
}
