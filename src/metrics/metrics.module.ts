import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProviderModule } from '../providers/provider.module';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

@Module({
  imports: [AuthModule, ProviderModule],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
