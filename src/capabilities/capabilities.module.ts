import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import {
  CapabilitiesController,
  PublicCapabilitiesController,
} from './capabilities.controller';

@Module({
  imports: [AuthModule],
  controllers: [CapabilitiesController, PublicCapabilitiesController],
})
export class CapabilitiesModule {}
