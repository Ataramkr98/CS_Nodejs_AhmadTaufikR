import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { z } from 'zod';
import { OperatorGuard, requireRole } from '../common/security';
import type { AuthenticatedRequest } from '../common/security';
import { parseInput } from '../common/validation';
import { TenantService } from './tenant.service';

const settingsSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    allowedOrigins: z.array(z.string().url()).max(30).optional(),
    timezone: z.string().min(1).max(80).optional(),
    language: z.enum(['id', 'en']).optional(),
    brandVoice: z.string().max(4000).optional(),
    businessHours: z
      .string()
      .regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/)
      .optional(),
    escalationThreshold: z.number().min(0).max(1).optional(),
    autoReplyEnabled: z.boolean().optional(),
    streamingEnabled: z.boolean().optional(),
    citationsEnabled: z.boolean().optional(),
    emailNotifications: z.boolean().optional(),
    pushNotifications: z.boolean().optional(),
    weeklyReports: z.boolean().optional(),
    autoThrottle: z.boolean().optional(),
    alertThreshold: z.number().int().min(50).max(95).optional(),
    dailyTokenBudget: z.number().int().min(0).max(1_000_000_000).optional(),
  })
  .strict();
const apiKeySchema = z.object({
  name: z.string().trim().min(2).max(100),
  scopes: z.array(z.string().min(1)).min(1).max(20),
  expiresAt: z.string().datetime().optional(),
});

@Controller('api')
@UseGuards(OperatorGuard)
export class TenantController {
  constructor(private readonly tenants: TenantService) {}

  @Get('tenants/me')
  me(@Req() request: AuthenticatedRequest) {
    return this.tenants.getProfile(request.user!.tenantId);
  }

  @Patch('tenants/me')
  update(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    requireRole(request.user!, UserRole.OWNER, UserRole.ADMIN);
    return this.tenants.updateProfile(
      request.user!.tenantId,
      parseInput(settingsSchema, body),
    );
  }

  @Get('settings')
  settings(@Req() request: AuthenticatedRequest) {
    return this.tenants.getProfile(request.user!.tenantId);
  }

  @Patch('settings')
  updateSettings(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    requireRole(request.user!, UserRole.OWNER, UserRole.ADMIN);
    return this.tenants.updateProfile(
      request.user!.tenantId,
      parseInput(settingsSchema, body),
    );
  }

  @Get('api-keys')
  apiKeys(@Req() request: AuthenticatedRequest) {
    requireRole(request.user!, UserRole.OWNER, UserRole.ADMIN);
    return this.tenants.listApiKeys(request.user!.tenantId);
  }

  @Post('api-keys')
  createApiKey(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    requireRole(request.user!, UserRole.OWNER, UserRole.ADMIN);
    const input = parseInput(apiKeySchema, body);
    return this.tenants.createApiKey(
      request.user!.tenantId,
      input.name,
      input.scopes,
      input.expiresAt ? new Date(input.expiresAt) : undefined,
    );
  }

  @Delete('api-keys/:id')
  revokeApiKey(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    requireRole(request.user!, UserRole.OWNER, UserRole.ADMIN);
    return this.tenants.revokeApiKey(request.user!.tenantId, id);
  }
}
