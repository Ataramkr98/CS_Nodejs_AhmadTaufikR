import {
  Injectable,
  Logger,
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
  private readonly logger = new Logger(KnowledgeService.name);
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
      storagePath?: string;
      content?: string;
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
          content: input.content,
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
    if (limit <= 0) return [];
    let semantic: RetrievalHit[] = [];
    try {
      const embedding = await this.providers.embed(query);
      const vector = `[${embedding.join(',')}]`;
      semantic = await this.prisma.withTenant(tenantId, (tx) =>
        tx.$queryRaw<RetrievalHit[]>(Prisma.sql`
        SELECT c.id AS "chunkId", c."sourceId" AS "sourceId", s.title AS "sourceTitle", c.content AS content,
          (1 - (c.embedding <=> ${vector}::vector))::float AS score
        FROM "KnowledgeChunk" c
        INNER JOIN "KnowledgeSource" s ON s.id = c."sourceId"
        WHERE c."tenantId" = ${tenantId} AND s."tenantId" = ${tenantId}
          AND c.embedding IS NOT NULL AND s.status = 'READY'
        ORDER BY c.embedding <=> ${vector}::vector
        LIMIT ${limit}
      `),
      );
    } catch {
      this.logger.warn('Semantic retrieval unavailable; using text matching.');
    }
    // READY text sources can exist without vectors, including seeded sources.
    // They must still be available to drafting when embeddings are absent.
    const terms = knowledgeSearchTerms(query);
    if (!terms.length) return semantic;
    const matches = terms.map(
      (term) => Prisma.sql`(
      CASE WHEN c.content ILIKE ${'%' + term + '%'} THEN 1 ELSE 0 END +
      CASE WHEN s.title ILIKE ${'%' + term + '%'} THEN 2 ELSE 0 END
    )`,
    );
    const rank = Prisma.sql`(${Prisma.join(matches, ' + ')})`;
    const lexical = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<Array<Omit<RetrievalHit, 'score'>>>(Prisma.sql`
        SELECT c.id AS "chunkId", c."sourceId" AS "sourceId", s.title AS "sourceTitle",
          c.content AS content
        FROM "KnowledgeChunk" c
        INNER JOIN "KnowledgeSource" s ON s.id = c."sourceId"
        WHERE c."tenantId" = ${tenantId} AND s."tenantId" = ${tenantId}
          AND s.status = 'READY' AND ${rank} > 0
        ORDER BY ${rank} DESC, c.ordinal ASC, c.id ASC
        LIMIT ${limit}
      `),
    );
    // Lexical relevance measures covered query concepts, not vector similarity
    // or a model's probability of being correct. Aliases count once, so adding
    // a translation cannot inflate the denominator or the score.
    const merged = new Map(semantic.map((hit) => [hit.chunkId, hit]));
    for (const hit of lexical) {
      const score = lexicalRelevance(
        query,
        hit.sourceTitle + ' ' + hit.content,
      );
      if (score > (merged.get(hit.chunkId)?.score ?? 0)) {
        merged.set(hit.chunkId, { ...hit, score });
      }
    }
    return [...merged.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async extractUpload(type: SourceType, buffer: Buffer): Promise<string> {
    if (type === SourceType.MARKDOWN || type === SourceType.TEXT)
      return normalize(buffer.toString('utf8'));
    if (type === SourceType.DOCX) {
      const mammoth = await import('mammoth');
      return normalize((await mammoth.extractRawText({ buffer })).value);
    }
    if (type === SourceType.PDF) {
      const parser = (await import('pdf-parse')).default as (
        input: Buffer,
      ) => Promise<{ text: string }>;
      return normalize((await parser(buffer)).text);
    }
    throw new ServiceUnavailableException('This source type is not supported.');
  }

  private async extractContent(source: {
    type: SourceType;
    content: string | null;
    storagePath: string | null;
  }): Promise<string> {
    if (source.type === SourceType.TEXT || source.content !== null)
      return normalize(source.content ?? '');
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

const SEARCH_STOP_WORDS = new Set([
  'apa',
  'apakah',
  'bisa',
  'boleh',
  'bagaimana',
  'berapa',
  'dengan',
  'dari',
  'dan',
  'yang',
  'untuk',
  'saya',
  'anda',
  'ingin',
  'mau',
  'ada',
  'itu',
  'ini',
  'the',
  'and',
  'can',
  'you',
  'how',
  'what',
  'with',
  'for',
  'please',
  'which',
  'are',
  'is',
  'your',
  'our',
  'does',
  'use',
  'available',
  'about',
  'have',
  'accept',
  'accepted',
]);

const SEARCH_ALIASES: Record<string, string> = {
  kirim: 'pengiriman',
  kirimkan: 'pengiriman',
  dikirim: 'pengiriman',
  mengirim: 'pengiriman',
  shipping: 'pengiriman',
  ship: 'pengiriman',
  delivery: 'pengiriman',
  carrier: 'kurir',
  carriers: 'kurir',
  courier: 'kurir',
  couriers: 'kurir',
  pay: 'pembayaran',
  payment: 'pembayaran',
  payments: 'pembayaran',
  bayar: 'pembayaran',
  return: 'retur',
  returns: 'retur',
  policy: 'kebijakan',
  tukar: 'penukaran',
  menukar: 'penukaran',
  exchange: 'penukaran',
  exchanges: 'penukaran',
};

function queryTerms(query: string): string[] {
  return (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (term) => term.length >= 3 && !SEARCH_STOP_WORDS.has(term),
  );
}

/** Fraction of distinct query concepts found in the retrieved source. */
export function lexicalRelevance(query: string, text: string): number {
  const concepts = new Set(
    queryTerms(query).map((term) => SEARCH_ALIASES[term] ?? term),
  );
  if (!concepts.size) return 0;
  const found = new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(
      (term) => SEARCH_ALIASES[term] ?? term,
    ),
  );
  return [...concepts].filter((term) => found.has(term)).length / concepts.size;
}

function knowledgeSearchTerms(query: string): string[] {
  const terms = queryTerms(query);
  return [
    ...new Set(
      terms.flatMap((term) =>
        SEARCH_ALIASES[term] ? [term, SEARCH_ALIASES[term]] : [term],
      ),
    ),
  ].slice(0, 12);
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
