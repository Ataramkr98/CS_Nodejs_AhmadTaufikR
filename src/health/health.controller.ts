import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';

@Controller('api/health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  live() {
    return {
      status: 'ok',
      service: 'cs-pintar-api',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        status: 'ready',
        database: 'ok',
        queueMode:
          this.config.get('QUEUE_ENABLED') === 'true' ? 'bullmq' : 'in-process',
        aiMode: this.config.get('AI_MODE', 'live'),
      };
    } catch {
      throw new ServiceUnavailableException('Database is not ready.');
    }
  }
}
