import { All, Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { OperatorGuard } from '../common/security';
import type { AuthenticatedRequest } from '../common/security';
import { featureUnavailable } from '../common/problem';
import { CAPABILITIES } from './capabilities.data';

@Controller('api')
@UseGuards(OperatorGuard)
export class CapabilitiesController {
  @Get('capabilities')
  list(@Req() request: AuthenticatedRequest) {
    return {
      tenantId: request.user!.tenantId,
      capabilities: CAPABILITIES,
    };
  }

  @All('ai-coach/:action')
  coach(@Param('action') action: string) {
    throw featureUnavailable(`AI Coach action '${action}'`);
  }

  @All('future/:feature')
  future(@Param('feature') feature: string) {
    throw featureUnavailable(feature);
  }
}

/**
 * Unauthenticated variant consumed by the public marketing page, so the site
 * can only ever advertise capabilities the API reports as available.
 */
@Controller('api/public')
export class PublicCapabilitiesController {
  @Get('capabilities')
  list() {
    return { capabilities: CAPABILITIES };
  }
}
