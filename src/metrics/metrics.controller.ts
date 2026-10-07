import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { OperatorGuard } from '../common/security';
import type { AuthenticatedRequest } from '../common/security';
import { parseInput } from '../common/validation';
import { MetricsService } from './metrics.service';

const rangeSchema = z.object({
  range: z.enum(['24h', '7d', '30d', '90d']).default('24h'),
});

@Controller('api')
@UseGuards(OperatorGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('analytics')
  analytics(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.metrics.analytics(
      request.user!.tenantId,
      parseInput(rangeSchema, query).range,
    );
  }

  @Get('dashboard/overview')
  dashboard(@Req() request: AuthenticatedRequest) {
    return this.metrics.dashboard(request.user!.tenantId);
  }

  @Get('usage')
  usage(@Req() request: AuthenticatedRequest) {
    return this.metrics.usage(request.user!.tenantId);
  }

  @Get('insights')
  insights(@Req() request: AuthenticatedRequest) {
    return this.metrics.insights(request.user!.tenantId);
  }

  @Get('analytics/top-unanswered')
  topUnanswered(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.metrics.topUnanswered(
      request.user!.tenantId,
      parseInput(rangeSchema, query).range,
    );
  }
}
