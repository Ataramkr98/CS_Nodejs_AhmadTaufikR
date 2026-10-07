import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsageModule } from '../usage/usage.module';
import { ProviderController } from './provider.controller';
import { ProviderService } from './provider.service';

@Module({
  imports: [AuthModule, UsageModule],
  controllers: [ProviderController],
  providers: [ProviderService],
  exports: [ProviderService],
})
export class ProviderModule {}
