import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma, SourceStatus, SourceType } from '@prisma/client';
import { readFile } from 'fs/promises';
import { RetrievalHit } from '../common/contracts';
import { PrismaService } from '../database/prisma.service';
import { ProviderService } from '../providers/provider.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

@Injectable()
export class KnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderService,
    private readonly moduleRef: ModuleRef,
    private readonly realtime: RealtimeGateway,
  ) {}

  async list(
    tenantId: string,
    input: {
      query?: string;
      status?: SourceStatus;
      limit?: number;
      cursor?: string;
    },
  ) {
    const limit = input.limit ?? 25;
    const where = {
      tenantId,
      status: { not: SourceStatus.DELETED },
      ...(input.status ? { status: input.status } : {}),
      ...(input.query
        ? { title: { contains: input.query, mode: 'insensitive' as const } }
        : {}),
    };
    const sources = await this.prisma.withTenant(tenantId, (tx) =>
      tx.knowledgeSource.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      }),
    );
    const next = sources.length > limit ? sources.pop() : undefined;
    return { data: sources, nextCursor: next?.id ?? null };
  }

  async get(tenantId: string, sourceId: string) {
    const source = await this.prisma.withTenant(tenantId, (tx) =>
      tx.knowledgeSource.findFirst({
        where: {
          id: sourceId,
          tenantId,
          status: { not: SourceStatus.DELETED },
        },
      }),
    );
    if (!source) throw new NotFoundException('Knowledge source not found.');
    return source;
  }

  async createText(
    tenantId: string,
    input: { title: string; content: string },
  ) {
    const source = await this.prisma.withTenant(tenantId, (tx) =>
      tx.knowledgeSource.create({
        data: {
          tenantId,
          title: input.title,
          type: SourceType.TEXT,
          content: input.content,
          byteSize: Buffer.byteLength(input.content),
        },
      }),
    );
    await this.jobsService.enqueueIngestion(tenantId, source.id);
    return source;
  }

  async createUpload(
    tenantId: string,
    input: {
      title: string;
      type: SourceType;
      mimeType: string;
      filename: string;
      storagePath: string;
      byteSize: number;
    },
  ) {
    const source = await this.prisma.withTenant(tenantId, (tx) =>
      tx.knowledgeSource.create({
        data: {
          tenantId,
          title: input.title,
          type: input.type,
          mimeType: input.mimeType,
          filename: input.filename,
          storagePath: input.storagePath,
          byteSize: input.byteSize,
        },
      }),
    );
    await this.jobsService.enqueueIngestion(tenantId, source.id);
    return source;
  }

  async reindex(tenantId: string, sourceId: string) {
    await this.get(tenantId, sourceId);
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.knowledgeSource.update({
        where: { id: sourceId },
        data: { status: SourceStatus.PENDING, errorMessage: null },
      }),
    );
    await this.jobsService.enqueueIngestion(tenantId, sourceId);
    return { sourceId, status: SourceStatus.PENDING };
  }

  async remove(tenantId: string, sourceId: string) {
    await this.get(tenantId, sourceId);
    await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.knowledgeSource.update({
        where: { id: sourceId },
        data: { status: SourceStatus.DELETED },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          action: 'knowledge-source.deleted',
          entityType: 'KnowledgeSource',
          entityId: sourceId,
        },
      });
    });
    this.realtime.emitTenant(tenantId, 'knowledge-source.updated', {
      sourceId,
      status: SourceStatus.DELETED,
    });
    return { ok: true };
  }

  async capacity(tenantId: string) {
    const [chunkCount, sourceCount, cited] = await this.prisma.withTenant(
      tenantId,
      (tx) =>
        Promise.all([
          tx.knowledgeChunk.count({ where: { tenantId } }),
          tx.knowledgeSource.count({
            where: { tenantId, status: { not: SourceStatus.DELETED } },
          }),
          tx.messageCitation.groupBy({
            by: ['sourceId'],
            where: { message: { tenantId } },
            _count: { sourceId: true },
            orderBy: { _count: { sourceId: 'desc' } },
            take: 3,
          }),
        ]),
    );
    const topSources = await Promise.all(
      cited.map(async (item) => ({
        source: await this.prisma.withTenant(tenantId, (tx) =>
          tx.knowledgeSource.findUnique({
            where: { id: item.sourceId },
            select: { id: true, title: true },
          }),
        ),
        hits: item._count.sourceId,
      })),
    );
    return {
      sourceCount,
      chunkCount,
      vectorDimension: 768,
      topSources: topSources.filter((item) => item.source),
    };
  }

  async processSource(tenantId: string, sourceId: string): Promise<void> {
    try {
      const source = await this.get(tenantId, sourceId);
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.knowledgeSource.update({
          where: { id: sourceId },
          data: { status: SourceStatus.PROCESSING, errorMessage: null },
        }),
      );
      this.realtime.emitTenant(tenantId, 'knowledge-source.updated', {
        sourceId,
        status: SourceStatus.PROCESSING,
      });
      const content = await this.extractContent(source);
      const chunks = chunkText(content);
      if (!chunks.length)
        throw new Error('The source did not contain extractable text.');
      const embeddings = await Promise.all(
        chunks.map((chunk) => this.providers.embed(chunk)),
      );
      await this.prisma.withTenant(tenantId, async (tx) => {
        await tx.knowledgeChunk.deleteMany({ where: { tenantId, sourceId } });
        for (const [ordinal, contentChunk] of chunks.entries()) {
          const chunk = await tx.knowledgeChunk.create({
            data: {
              tenantId,
              sourceId,
              ordinal,
              content: contentChunk,
              metadata: { characters: contentChunk.length },
            },
          });
          const vector = `[${embeddings[ordinal].join(',')}]`;
          await tx.$executeRaw(
            Prisma.sql`UPDATE "KnowledgeChunk" SET embedding = ${vector}::vector WHERE id = ${chunk.id} AND "tenantId" = ${tenantId}`,
          );
        }
        await tx.knowledgeSource.update({
          where: { id: sourceId },
          data: {
            content: source.type === SourceType.TEXT ? content : undefined,
            status: SourceStatus.READY,
            chunkCount: chunks.length,
            indexedAt: new Date(),
            errorMessage: null,
          },
        });
      });
      this.realtime.emitTenant(tenantId, 'knowledge-source.updated', {
        sourceId,
        status: SourceStatus.READY,
        chunkCount: chunks.length,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown indexing error.';
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.knowledgeSource.update({
          where: { id: sourceId },
          data: { status: SourceStatus.FAILED, errorMessage: message },
        }),
      );
      this.realtime.emitTenant(tenantId, 'knowledge-source.updated', {
        sourceId,
        status: SourceStatus.FAILED,
        error: message,
      });
    }
  }

  async search(
    tenantId: string,
    query: string,
    limit = 4,
  ): Promise<RetrievalHit[]> {
    const embedding = await this.providers.embed(query);
    const vector = `[${embedding.join(',')}]`;
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<RetrievalHit[]>(Prisma.sql`
        SELECT c.id AS "chunkId", c."sourceId" AS "sourceId", s.title AS "sourceTitle", c.content AS content,
          (1 - (c.embedding <=> ${vector}::vector))::float AS score
        FROM "KnowledgeChunk" c
        INNER JOIN "KnowledgeSource" s ON s.id = c."sourceId"
        WHERE c."tenantId" = ${tenantId} AND c.embedding IS NOT NULL AND s.status = 'READY'
        ORDER BY c.embedding <=> ${vector}::vector
        LIMIT ${limit}
      `),
    );
  }

  private async extractContent(source: {
    type: SourceType;
    content: string | null;
    storagePath: string | null;
  }): Promise<string> {
    if (source.type === SourceType.TEXT) return normalize(source.content ?? '');
    if (!source.storagePath)
      throw new ServiceUnavailableException(
        'The uploaded source is missing its secure storage path.',
      );
    if (source.type === SourceType.MARKDOWN)
      return normalize(await readFile(source.storagePath, 'utf8'));
    if (source.type === SourceType.DOCX) {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ path: source.storagePath });
      return normalize(result.value);
    }
    if (source.type === SourceType.PDF) {
      const parser = (await import('pdf-parse')).default as (
        input: Buffer,
      ) => Promise<{ text: string }>;
      const result = await parser(await readFile(source.storagePath));
      return normalize(result.text);
    }
    throw new ServiceUnavailableException(
      'This source type is not enabled in the MVP.',
    );
  }

  private get jobsService(): {
    enqueueIngestion(tenantId: string, sourceId: string): Promise<void>;
  } {
    return this.moduleRef.get('JobsService', { strict: false });
  }
}

function normalize(value: string): string {
  return value.replaceAll('\0', '').replace(/\s+/g, ' ').trim();
}

export function chunkText(value: string, size = 800, overlap = 120): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < value.length; start += size - overlap) {
    const chunk = value.slice(start, start + size).trim();
    if (chunk) chunks.push(chunk);
    if (start + size >= value.length) break;
  }
  return chunks;
}
