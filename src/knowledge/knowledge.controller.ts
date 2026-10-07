import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SourceStatus, SourceType, UserRole } from '@prisma/client';
import { mkdir, writeFile } from 'fs/promises';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { OperatorGuard, requireRole } from '../common/security';
import type { AuthenticatedRequest } from '../common/security';
import { paginationSchema, parseInput } from '../common/validation';
import { KnowledgeService } from './knowledge.service';

const textSchema = z.object({
  title: z.string().trim().min(2).max(240),
  content: z.string().trim().min(1).max(1_000_000),
});
const sourceQuery = paginationSchema.extend({
  query: z.string().trim().max(120).optional(),
  status: z.nativeEnum(SourceStatus).optional(),
});

@Controller('api/kb')
@UseGuards(OperatorGuard)
export class KnowledgeController {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  list(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.knowledge.list(
      request.user!.tenantId,
      parseInput(sourceQuery, query),
    );
  }

  @Get('capacity')
  capacity(@Req() request: AuthenticatedRequest) {
    return this.knowledge.capacity(request.user!.tenantId);
  }

  @Post()
  createText(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    requireRole(request.user!, UserRole.OWNER, UserRole.ADMIN, UserRole.AGENT);
    return this.knowledge.createText(
      request.user!.tenantId,
      parseInput(textSchema, body),
    );
  }

  @Post('upload')
  async upload(@Req() request: AuthenticatedRequest) {
    requireRole(request.user!, UserRole.OWNER, UserRole.ADMIN, UserRole.AGENT);
    const fileRequest = request as AuthenticatedRequest & {
      file: () => Promise<
        | {
            filename: string;
            mimetype: string;
            toBuffer: () => Promise<Buffer>;
            fields: Record<string, { value?: string }>;
          }
        | undefined
      >;
    };
    const file = await fileRequest.file();
    if (!file) throw new BadRequestException('A multipart file is required.');
    const type = inferSourceType(file.filename, file.mimetype);
    const buffer = await file.toBuffer();
    const maxBytes = Number(
      this.config.get('MAX_UPLOAD_BYTES', 20 * 1024 * 1024),
    );
    if (buffer.byteLength > maxBytes)
      throw new BadRequestException(
        `Upload exceeds the ${maxBytes} byte limit.`,
      );
    const directory = join(
      this.config.get('UPLOAD_DIR', 'uploads'),
      request.user!.tenantId,
    );
    await mkdir(directory, { recursive: true });
    const storagePath = join(
      directory,
      `${randomUUID()}${extname(file.filename).toLowerCase()}`,
    );
    await writeFile(storagePath, buffer, { flag: 'wx' });
    const fields = file.fields as unknown as { title?: { value?: string } };
    const title = fields.title?.value?.trim() || file.filename;
    return this.knowledge.createUpload(request.user!.tenantId, {
      title,
      type,
      mimeType: file.mimetype,
      filename: file.filename,
      storagePath,
      byteSize: buffer.byteLength,
    });
  }

  @Get(':sourceId')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('sourceId') sourceId: string,
  ) {
    return this.knowledge.get(request.user!.tenantId, sourceId);
  }

  @Post(':sourceId/reindex')
  reindex(
    @Req() request: AuthenticatedRequest,
    @Param('sourceId') sourceId: string,
  ) {
    requireRole(request.user!, UserRole.OWNER, UserRole.ADMIN, UserRole.AGENT);
    return this.knowledge.reindex(request.user!.tenantId, sourceId);
  }

  @Delete(':sourceId')
  remove(
    @Req() request: AuthenticatedRequest,
    @Param('sourceId') sourceId: string,
  ) {
    requireRole(request.user!, UserRole.OWNER, UserRole.ADMIN);
    return this.knowledge.remove(request.user!.tenantId, sourceId);
  }
}

function inferSourceType(filename: string, mimeType: string): SourceType {
  const extension = extname(filename).toLowerCase();
  if (extension === '.pdf' || mimeType === 'application/pdf')
    return SourceType.PDF;
  if (
    extension === '.docx' ||
    mimeType ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  )
    return SourceType.DOCX;
  if (
    ['.md', '.markdown'].includes(extension) ||
    mimeType.startsWith('text/markdown')
  )
    return SourceType.MARKDOWN;
  throw new BadRequestException(
    'Only PDF, DOCX, and Markdown uploads are supported in this MVP.',
  );
}
