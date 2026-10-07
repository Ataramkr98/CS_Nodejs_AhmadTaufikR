import {
  ConversationChannel,
  ConversationStatus,
  MessageRole,
  MessageStatus,
  PrismaClient,
  ProviderKind,
  SourceStatus,
  SourceType,
  UserRole,
} from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

const DEMO_WIDGET_KEY = 'demo-widget-key';
const DEMO_EMAIL = 'demo@cspintar.io';
const DEMO_PASSWORD = 'DemoPassword123!';

/** Deterministic PRNG so repeated seeds produce the same demo dataset. */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const random = makeRandom(20260901);
const pick = <T>(values: readonly T[]): T =>
  values[Math.floor(random() * values.length)];
const between = (min: number, max: number) =>
  Math.floor(random() * (max - min + 1)) + min;

const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (days: number, hourOffset = 0) =>
  new Date(Date.now() - days * DAY_MS + hourOffset * 60 * 60 * 1000);

/**
 * Portfolio demo seed.
 *
 * Every operational screen must show believable data straight after
 * `npm run db:setup` — an empty app reads as unfinished. The dataset is
 * deterministic, scoped to one tenant, and weighted towards "resolved by AI"
 * with a realistic slice of escalations so analytics and insights have
 * something honest to compute.
 */
async function main() {
  console.log('Seeding demo dataset...');

  const passwordHash = await argon2.hash(DEMO_PASSWORD);

  /* ------------------------------------------------------------- tenant --- */

  const demoTenant = await prisma.tenant.upsert({
    where: { widgetKey: DEMO_WIDGET_KEY },
    update: { name: 'Toko Serba Ada (Demo)' },
    create: {
      name: 'Toko Serba Ada (Demo)',
      widgetKey: DEMO_WIDGET_KEY,
      allowedOrigins: ['http://localhost:3000'],
    },
  });

  await prisma.tenantSettings.upsert({
    where: { tenantId: demoTenant.id },
    update: {},
    create: {
      tenantId: demoTenant.id,
      timezone: 'Asia/Jakarta',
      language: 'id',
      brandVoice:
        'Ramah dan singkat. Selalu jawab hanya dari knowledge base. Jika tidak yakin, alihkan ke agen manusia.',
      businessHours: '09:00-21:00',
      escalationThreshold: 0.65,
      dailyTokenBudget: 250_000,
      alertThreshold: 80,
    },
  });

  // A second tenant proves the data layer really does isolate workspaces:
  // signing in as this account shows an empty console, not demo data.
  const otherTenant = await prisma.tenant.upsert({
    where: { widgetKey: 'second-tenant-widget-key' },
    update: {},
    create: {
      name: 'Kopi Seru (Second Tenant)',
      widgetKey: 'second-tenant-widget-key',
      allowedOrigins: [],
    },
  });
  await prisma.tenantSettings.upsert({
    where: { tenantId: otherTenant.id },
    update: {},
    create: {
      tenantId: otherTenant.id,
      timezone: 'Asia/Jakarta',
      brandVoice: 'Santai, fokus pada kopi single origin.',
    },
  });
  await prisma.user.upsert({
    where: { email: 'owner@kopiseru.id' },
    update: {},
    create: {
      email: 'owner@kopiseru.id',
      name: 'Rani (Kopi Seru)',
      passwordHash,
      role: UserRole.OWNER,
      tenantId: otherTenant.id,
    },
  });

  /* -------------------------------------------------------------- users --- */

  const demoUsers = [
    { email: DEMO_EMAIL, name: 'Demo Admin', role: UserRole.OWNER },
    { email: 'agent@cspintar.io', name: 'Agen Demo', role: UserRole.AGENT },
    {
      email: 'viewer@cspintar.io',
      name: 'Pengawas Demo',
      role: UserRole.VIEWER,
    },
  ];
  for (const user of demoUsers) {
    await prisma.user.upsert({
      where: { email: user.email },
      update: { name: user.name, role: user.role, tenantId: demoTenant.id },
      create: { ...user, passwordHash, tenantId: demoTenant.id },
    });
  }
  console.log(
    `  users: ${demoUsers.length} (login ${DEMO_EMAIL} / ${DEMO_PASSWORD})`,
  );

  /* ---------------------------------------------------------- providers --- */

  const providerDefaults = [
    {
      provider: ProviderKind.AUTOAPP,
      model: 'minimax-m3',
      enabled: true,
      priority: 1,
      dailyLimit: 200,
    },
    {
      provider: ProviderKind.AUTOAPP,
      model: 'glm-5.3-flash',
      enabled: true,
      priority: 2,
      dailyLimit: 300,
    },
    {
      provider: ProviderKind.AUTOAPP,
      model: 'kimi-k3',
      enabled: false,
      priority: 3,
    },
    {
      provider: ProviderKind.GROQ,
      model: 'llama-3.3-70b-versatile',
      enabled: true,
      priority: 10,
    },
    {
      provider: ProviderKind.GROQ,
      model: 'llama-3.1-8b-instant',
      enabled: false,
      priority: 20,
    },
  ];
  for (const defaults of providerDefaults) {
    await prisma.tenantProviderConfig.upsert({
      where: {
        tenantId_provider_model: {
          tenantId: demoTenant.id,
          provider: defaults.provider,
          model: defaults.model,
        },
      },
      update: {
        enabled: defaults.enabled,
        priority: defaults.priority,
        dailyLimit: defaults.dailyLimit,
      },
      create: { tenantId: demoTenant.id, ...defaults },
    });
  }

  /* ---------------------------------------------------------- knowledge --- */

  const documents = [
    {
      id: 'demo-kb-pengiriman',
      title: 'Kebijakan Pengiriman & Ongkir',
      type: SourceType.TEXT,
      content: [
        'Pengiriman diproses 1x24 jam setiap hari kerja.',
        'Kurir: JNE Reguler, J&T Express, dan SiCepat BEST.',
        'Estimasi Jabodetabek 2-3 hari kerja, Jawa 3-4 hari, luar Jawa 4-7 hari kerja.',
        'Gratis ongkir untuk pembelian di atas Rp 200.000 se-Jawa dan Rp 350.000 luar Jawa.',
        'Nomor resi dikirim via email dan WhatsApp maksimal 1x24 jam setelah pesanan diproses.',
      ],
    },
    {
      id: 'demo-kb-retur',
      title: 'Kebijakan Retur & Penukaran',
      type: SourceType.MARKDOWN,
      content: [
        '# Retur\nRetur diterima maksimal 7 hari setelah barang diterima.',
        '# Syarat\nSegel dan kelengkapan produk harus utuh.',
        '# Refund\nRefund diproses ke metode pembayaran asli dalam 3x24 jam kerja.',
        '# Ongkir retur\nOngkir retur ditanggung toko untuk kesalahan pengiriman.',
        '# Barang rusak\nKirimkan foto atau video bukti kerusakan melalui halaman bantuan.',
      ],
    },
    {
      id: 'demo-kb-pembayaran',
      title: 'Metode Pembayaran & Promo',
      type: SourceType.TEXT,
      content: [
        'Pembayaran accepts transfer bank, e-wallet (GoPay, OVO, DANA, ShopeePay), dan kartu kredit.',
        'Virtual account BCA, Mandiri, BNI, dan BRI tersedia untuk transfer bank.',
        'Kode promo dapat digabung dengan gratis ongkir, kecuali pada flash sale.',
        'Pembayaran ditahan sampai konfirmasi dari payment gateway sebelum pesanan diproses.',
        'Invoice resmi dikirim ke email pelanggan dalam 10 menit setelah pembayaran berhasil.',
      ],
    },
    {
      id: 'demo-kb-katalog',
      title: 'Panduan Produk & Ukuran',
      type: SourceType.TEXT,
      content: [
        'Pakaian Größen mengikuti standar Asia (S: 88-94 cm, M: 95-101 cm, L: 102-108 cm).',
        'Sepatu mengikuti standar EU: 39 sampai 44, dengan selisih +-1 cm per nomor.',
        'Tas kerja tahan air minimal 500D dan muatan hingga 15 kg.',
        'Semua produk bergaransi 6 bulan untuk kerusakan atau cacat pabrik.',
      ],
    },
  ];

  const chunksBySource = new Map<string, string[]>();
  for (const document of documents) {
    await prisma.knowledgeSource.upsert({
      where: { id: document.id },
      update: {},
      create: {
        id: document.id,
        tenantId: demoTenant.id,
        title: document.title,
        type: document.type,
        mimeType:
          document.type === SourceType.MARKDOWN
            ? 'text/markdown'
            : 'text/plain',
        content: document.content.join('\n\n'),
        status: SourceStatus.READY,
        chunkCount: document.content.length,
        byteSize: Buffer.byteLength(document.content.join('\n\n')),
        indexedAt: ago(between(20, 27)),
        createdAt: ago(between(20, 28)),
      },
    });
    const chunks = document.content;
    chunksBySource.set(document.id, chunks);
    if (
      (await prisma.knowledgeChunk.count({
        where: { sourceId: document.id },
      })) === 0
    ) {
      for (const [ordinal, content] of chunks.entries()) {
        await prisma.knowledgeChunk.create({
          data: {
            tenantId: demoTenant.id,
            sourceId: document.id,
            ordinal,
            content,
            metadata: { seeded: true, charCount: content.length },
          },
        });
      }
    }
  }
  console.log(`  knowledge sources: ${documents.length}`);

  /* --------------------------------------------------------- customers --- */

  const customerFixtures = [
    { email: 'ratna@example.id', name: 'Ratna Dewi' },
    { email: 'budi@example.id', name: 'Budi Hartono' },
    { email: 'siti@example.id', name: 'Siti Nurhaliza' },
    { email: 'rizky@example.id', name: 'Rizky Pratama' },
    { email: 'dewi@example.id', name: 'Dewi Lestari' },
    { email: 'fajar@example.id', name: 'Fajar Nugroho' },
    { email: 'intan@example.id', name: 'Intan Permata' },
    { email: 'agus@example.id', name: 'Agus Salim' },
  ];
  const customers = [];
  for (const fixture of customerFixtures) {
    customers.push(
      await prisma.customer.upsert({
        where: {
          tenantId_email: { tenantId: demoTenant.id, email: fixture.email },
        },
        update: { name: fixture.name },
        create: {
          tenantId: demoTenant.id,
          email: fixture.email,
          name: fixture.name,
          createdAt: ago(between(5, 30)),
        },
      }),
    );
  }

  /* ------------------------------------------------------- conversations --- */

  const questionBank: Array<{
    question: string;
    answer: string;
    topic: string;
    sourceIndex: number;
  }> = [
    {
      question: 'Berapa lama pesanan saya sampai?',
      answer:
        'Estimasi tiba 2-3 hari kerja untuk Jabodetabek, 3-4 hari untuk Jawa, dan 4-7 hari kerja untuk luar Jawa. Nomor resi kami kirim maksimal 1x24 jam setelah pesanan diproses.',
      topic: 'pengiriman',
      sourceIndex: 0,
    },
    {
      question: 'Apakah ada gratis ongkir?',
      answer:
        'Bisa. Gratis ongkir berlaku untuk pembelian di atas Rp 200.000 se-Jawa dan Rp 350.000 untuk luar Jawa, dan dapat digabung dengan kode promo.',
      topic: 'ongkir',
      sourceIndex: 0,
    },
    {
      question: 'Kurir apa yang dipakai?',
      answer:
        'Kami memakai JNE Reguler, J&T Express, dan SiCepat BEST. Kurir terbaik ditentukan otomatis dari lokasi tujuan Anda.',
      topic: 'kurir',
      sourceIndex: 0,
    },
    {
      question: 'Bagaimana cara retur barang?',
      answer:
        'Retur diterima maksimal 7 hari setelah barang tiba dengan segel utuh. Ongkos retur ditanggung toko bila kesalahan pengiriman. Setelah produk kami terima, refund diproses dalam 3x24 jam kerja.',
      topic: 'retur',
      sourceIndex: 1,
    },
    {
      question: 'Apakah bisa tukar ukuran?',
      answer:
        'Bisa, selama segel masih utuh dan tidak lebih dari 7 hari sejak barang diterima. Ongkir tukar ditanggung pemesan.',
      topic: 'retur',
      sourceIndex: 1,
    },
    {
      question: 'Metode pembayaran apa saja yang diterima?',
      answer:
        'Transfer bank (BCA, Mandiri, BNI, BRI), e-wallet (GoPay, OVO, DANA, ShopeePay), dan kartu kredit. Invoice resmi dikirim ke email Anda maksimal 10 menit setelah pembayaran berhasil.',
      topic: 'pembayaran',
      sourceIndex: 2,
    },
    {
      question: 'Bisa bayar lewat transfer bank?',
      answer:
        'Bisa. Virtual account BCA, Mandiri, BNI, dan BRI tersedia dan pesanan langsung diproses setelah transfer terkonfirmasi.',
      topic: 'pembayaran',
      sourceIndex: 2,
    },
    {
      question: 'Berapa lama garansi produk?',
      answer:
        'Semua produk bergaransi 6 bulan untuk kerusakan atau cacat pabrik dengan bukti pembelian yang valid.',
      topic: 'produk',
      sourceIndex: 3,
    },
    {
      question: 'Bagaimana cara memilih ukuran pakaian?',
      answer:
        'Pakaian mengikuti standar Asia: S 88-94 cm, M 95-101 cm, L 102-108 cm. Sepatu mengikuti standar EU 39-44.',
      topic: 'ukuran',
      sourceIndex: 3,
    },
  ];

  const escalatedQuestions = [
    'Bisa kirim ke Papua dengan intermediary?',
    'Pesanan saya sudah 2 minggu belum sampai, tolong dicek',
    'Refund sudah 5 hari belum masuk ke rekening saya',
    'Apakah bisa tukar ke model terbaru?',
    'Bisa cooperation dropship mulai kapan?',
  ];

  const agentReplies = [
    'Saya bantu cek di sistem. Mohon tunggu sebentar.',
    'Terima kasih sudah melapor, saya eskalasikan ke tim terkait.',
    'Sudah saya teruskan ke tim logistik, kabari progressingnya di sini ya.',
    'Saya cek dulu ketersediaan stok untuk pesanan Anda.',
  ];

  if (
    (await prisma.conversation.count({ where: { tenantId: demoTenant.id } })) >
    0
  ) {
    console.log('  conversations: already present, skipping');
  } else {
    const usageRows: Array<{
      tenantId: string;
      provider: string;
      model: string;
      requestType: string;
      tokensIn: number;
      tokensOut: number;
      latencyMs: number;
      outcome: string;
      createdAt: Date;
    }> = [];

    // 30 days of history, denser towards today so the 24h view is never empty.
    for (let day = 29; day >= 0; day -= 1) {
      const perDay = day === 0 ? between(6, 10) : between(3, 8);
      for (let n = 0; n < perDay; n += 1) {
        const hourOffset = day === 0 ? -between(0, 20) : between(0, 20);
        const startedAt = ago(day, hourOffset);
        const escalated = random() < 0.28;
        const entry = pick(questionBank);
        const confidence = escalated
          ? Number((0.2 + random() * 0.3).toFixed(2))
          : Number((0.66 + random() * 0.3).toFixed(2));

        const conversation = await prisma.conversation.create({
          data: {
            tenantId: demoTenant.id,
            customerId: pick(customers).id,
            channel: pick([
              ConversationChannel.WEB,
              ConversationChannel.WEB,
              ConversationChannel.WEB,
              ConversationChannel.WEB,
              ConversationChannel.WHATSAPP,
            ]),
            status: escalated
              ? ConversationStatus.HANDOFF
              : ConversationStatus.RESOLVED,
            subject: entry.question,
            createdAt: startedAt,
            lastMessageAt: startedAt,
          },
        });

        await prisma.message.create({
          data: {
            tenantId: demoTenant.id,
            conversationId: conversation.id,
            role: MessageRole.CUSTOMER,
            status: MessageStatus.DELIVERED,
            content: entry.question,
            createdAt: startedAt,
          },
        });

        const model = pick(['minimax-m3', 'glm-5.3-flash']);
        const provider = 'AUTOAPP';
        const latencyMs = between(420, escalated ? 5200 : 2600);
        const answeredAt = new Date(startedAt.getTime() + latencyMs);

        const assistantMessage = await prisma.message.create({
          data: {
            tenantId: demoTenant.id,
            conversationId: conversation.id,
            role: MessageRole.ASSISTANT,
            status: MessageStatus.DELIVERED,
            content: escalated
              ? 'Maaf, saya belum menemukan informasi yang cukup untuk menjawab pertanyaan ini. Saya alihkan ke agen kami.'
              : entry.answer,
            provider,
            model,
            confidence,
            tokensIn: between(280, 900),
            tokensOut: between(40, 220),
            latencyMs,
            createdAt: answeredAt,
          },
        });

        if (!escalated) {
          const source = documents[entry.sourceIndex];
          const chunk = await prisma.knowledgeChunk.findFirstOrThrow({
            where: { sourceId: source.id },
            orderBy: { ordinal: 'asc' },
          });
          await prisma.messageCitation.create({
            data: {
              messageId: assistantMessage.id,
              sourceId: source.id,
              chunkId: chunk.id,
              score: confidence,
            },
          });
        }

        if (escalated) {
          await prisma.message.create({
            data: {
              tenantId: demoTenant.id,
              conversationId: conversation.id,
              role: MessageRole.AGENT,
              status: MessageStatus.DELIVERED,
              content: pick(agentReplies),
              createdAt: new Date(answeredAt.getTime() + 120_000),
            },
          });
        }

        await prisma.conversationEvent.createMany({
          data: [
            {
              conversationId: conversation.id,
              type: 'conversation.created',
              data: { channel: 'WEB' },
              createdAt: startedAt,
            },
            ...(escalated
              ? [
                  {
                    conversationId: conversation.id,
                    type: 'conversation.escalated' as const,
                    data: { confidence, threshold: 0.65 },
                    createdAt: answeredAt,
                  },
                ]
              : []),
          ],
        });

        usageRows.push({
          tenantId: demoTenant.id,
          provider,
          model,
          requestType: 'chat',
          tokensIn: between(280, 900),
          tokensOut: between(40, 220),
          latencyMs,
          outcome: escalated ? 'escalated' : 'completed',
          createdAt: answeredAt,
        });

        // A couple of conversations escalate on an unanswered question instead,
        // so the "top unanswered" list has genuinely human phrasing.
        if (random() < 0.06) {
          const askedAt = new Date(startedAt.getTime() + 400_000);
          await prisma.message.create({
            data: {
              tenantId: demoTenant.id,
              conversationId: conversation.id,
              role: MessageRole.CUSTOMER,
              status: MessageStatus.DELIVERED,
              content: pick(escalatedQuestions),
              createdAt: askedAt,
            },
          });
        }

        await prisma.auditLog.create({
          data: {
            tenantId: demoTenant.id,
            action: escalated
              ? 'conversation.escalated'
              : 'conversation.resolved',
            entityType: 'Conversation',
            entityId: conversation.id,
            details: { subject: entry.question, confidence, model },
            createdAt: answeredAt,
          },
        });
      }
    }

    if (usageRows.length) {
      await prisma.llmUsage.createMany({ data: usageRows });
    }
    console.log(
      `  conversations: ${await prisma.conversation.count({ where: { tenantId: demoTenant.id } })}, llm usage rows: ${usageRows.length}`,
    );
  }

  /* ------------------------------------------------------ audit trail ----- */

  await prisma.auditLog.create({
    data: {
      tenantId: demoTenant.id,
      action: 'tenant.seeded',
      entityType: 'Tenant',
      entityId: demoTenant.id,
      details: { sources: documents.length, note: 'demo dataset' },
      createdAt: ago(30),
    },
  });

  console.log('\nDemo dataset ready.');
  console.log(`  operator console : ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log('  second tenant    : owner@kopiseru.id / ' + DEMO_PASSWORD);
  console.log(`  widget key       : ${DEMO_WIDGET_KEY}`);
}

main()
  .catch((error) => {
    console.error('Seeding failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
