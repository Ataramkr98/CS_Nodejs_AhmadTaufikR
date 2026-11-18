import { Prisma } from '@prisma/client';
import {
  chunkText,
  KnowledgeService,
  lexicalRelevance,
} from './knowledge.service';
import { PrismaService } from '../database/prisma.service';
import { ProviderService } from '../providers/provider.service';
import { ModuleRef } from '@nestjs/core';
import { RealtimeGateway } from '../realtime/realtime.gateway';

describe('chunkText', () => {
  it('keeps all source content while producing bounded overlapping chunks', () => {
    const content = 'A'.repeat(900) + 'B'.repeat(900);
    const chunks = chunkText(content, 800, 120);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(800);
    expect(chunks[1].startsWith('A'.repeat(120))).toBe(true);
    expect(chunks.at(-1)).toContain('B'.repeat(100));
  });

  it('does not return blank chunks', () => {
    expect(chunkText('   \n\t  ')).toEqual([]);
  });
});

describe('Knowledge retrieval without embeddings', () => {
  let query: jest.Mock;
  let embed: jest.Mock;
  let service: KnowledgeService;
  const shipping = {
    chunkId: 'shipping-1',
    sourceId: 'shipping',
    sourceTitle: 'Kebijakan Pengiriman & Ongkir',
    content: 'Kurir: JNE Reguler, J&T Express, dan SiCepat BEST.',
    score: 0,
  };

  beforeEach(() => {
    query = jest.fn();
    embed = jest.fn().mockResolvedValue([0.1, 0.2]);
    const tx = { $queryRaw: query };
    const prisma = {
      withTenant: jest.fn((_id, callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    service = new KnowledgeService(
      prisma as unknown as PrismaService,
      { embed } as unknown as ProviderService,
      {} as ModuleRef,
      {} as RealtimeGateway,
    );
  });

  it('retrieves READY shipping text when the vector search finds no indexed chunks', async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([shipping]);
    await expect(
      service.search('tenant-1', 'Bisa kirim ke Papua dengan intermediary?'),
    ).resolves.toEqual([{ ...shipping, score: 1 / 3 }]);
    const sql = query.mock.calls[1][0] as Prisma.Sql;
    expect(sql.values).toContain('%kirim%');
    expect(sql.values).toContain('%pengiriman%');
    expect(sql.values).toContain('tenant-1');
    expect(sql.sql).toContain("s.status = 'READY'");
    expect(sql.sql).toContain('s."tenantId" =');
    expect(sql.sql).not.toContain('embedding IS NOT NULL');
  });

  it('keeps text retrieval available when the embedding provider fails', async () => {
    embed.mockRejectedValue(new Error('Embeddings unavailable'));
    query.mockResolvedValueOnce([shipping]);
    await expect(service.search('tenant-1', 'kirim Papua')).resolves.toEqual([
      { ...shipping, score: 0.5 },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('preserves semantic results when the lexical search adds no evidence', async () => {
    const semantic = [0, 1, 2, 3].map((index) => ({
      ...shipping,
      chunkId: 'vector-' + index,
      score: 0.9,
    }));
    query.mockResolvedValueOnce(semantic).mockResolvedValueOnce([]);
    await expect(service.search('tenant-1', 'shipping')).resolves.toEqual(
      semantic,
    );
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('deduplicates lexical fallback chunks without changing semantic confidence', async () => {
    const semantic = { ...shipping, score: 0.85 };
    const second = { ...shipping, chunkId: 'shipping-2' };
    query.mockResolvedValueOnce([semantic]).mockResolvedValueOnce([second]);
    const hits = await service.search('tenant-1', 'kirim');
    expect(hits).toEqual([{ ...second, score: 1 }, semantic]);
    expect(hits.filter((hit) => hit.chunkId === shipping.chunkId)).toHaveLength(
      1,
    );
  });

  it('binds query terms as SQL values rather than interpolating customer text', async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await service.search('tenant-1', "Papua'; DROP TABLE Customer; --");
    const sql = query.mock.calls[1][0] as Prisma.Sql;
    expect(sql.sql).not.toContain('DROP TABLE');
    expect(sql.values).toContain('%papua%');
  });

  it('uses actual keyword coverage when vector results for the same chunk are weak', async () => {
    query
      .mockResolvedValueOnce([{ ...shipping, score: 0.1 }])
      .mockResolvedValueOnce([shipping]);
    expect(
      await service.search(
        'tenant-1',
        'Which shipping carriers are available?',
      ),
    ).toEqual([{ ...shipping, score: 1 }]);
  });
});

describe('lexical relevance', () => {
  const shipping = 'Kebijakan Pengiriman. Kurir: JNE, J&T, dan SiCepat.';

  it('recognizes bilingual query concepts without treating a translation as another term', () => {
    expect(
      lexicalRelevance('Which shipping carriers are available?', shipping),
    ).toBe(1);
    expect(lexicalRelevance('shipping pengiriman', shipping)).toBe(1);
    expect(
      lexicalRelevance(
        'Can I pay by bank transfer?',
        'Pembayaran accepts transfer bank.',
      ),
    ).toBe(1);
    expect(
      lexicalRelevance(
        'What is your return and exchange policy?',
        'Kebijakan Retur & Penukaran',
      ),
    ).toBe(1);
  });

  it('keeps unsupported destination and service constraints below the handoff threshold', () => {
    expect(
      lexicalRelevance('Bisa kirim ke Papua dengan intermediary?', shipping),
    ).toBeCloseTo(1 / 3);
    expect(lexicalRelevance('Can you ship to Mars?', shipping)).toBe(0.5);
    expect(lexicalRelevance('What is the warranty?', shipping)).toBe(0);
    expect(lexicalRelevance('can you please', shipping)).toBe(0);
  });

  it('requires token matches instead of incidental substrings', () => {
    expect(lexicalRelevance('bank', 'A banking integration')).toBe(0);
  });
});
