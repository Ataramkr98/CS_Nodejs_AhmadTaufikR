import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { ProviderKind, UserRole } from '@prisma/client';
import { z } from 'zod';
import { OperatorGuard, requireRole } from '../common/security';
import type { AuthenticatedRequest } from '../common/security';
import { parseInput } from '../common/validation';
import { ProviderService } from './provider.service';

const providerSchema = z.object({
  provider: z.nativeEnum(ProviderKind),
  model: z.string().min(1).max(160),
  enabled: z.boolean(),
  priority: z.number().int().min(1).max(999),
  dailyLimit: z.number().int().positive().optional(),
});

@Controller('api/providers')
@UseGuards(OperatorGuard)
export class ProviderController {
  constructor(private readonly providers: ProviderService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest) {
    return this.providers.list(request.user!.tenantId);
  }

  @Patch()
  async update(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    requireRole(request.user!, UserRole.OWNER, UserRole.ADMIN);
    return this.providers.update(
      request.user!.tenantId,
      parseInput(providerSchema, body),
    );
  }
}
