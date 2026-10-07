import { Global, Module } from '@nestjs/common';
import { JobsService } from './jobs.service';

@Global()
@Module({
  providers: [
    JobsService,
    { provide: 'JobsService', useExisting: JobsService },
  ],
  exports: [JobsService, 'JobsService'],
})
export class JobsModule {}
