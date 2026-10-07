import { Injectable } from '@nestjs/common';
import { ConversationStatus, MessageRole } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { ProviderService } from '../providers/provider.service';

const RANGE_MS: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

@Injectable()
export class MetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderService,
  ) {}

  async analytics(tenantId: string, range = '24h') {
    const since = new Date(Date.now() - (RANGE_MS[range] ?? RANGE_MS['24h']));
    const [
      totalMessages,
      assistantMessages,
      activeConversations,
      escalatedConversations,
      usage,
      latencyRows,
      byChannel,
      recentMessages,
    ] = await this.prisma.withTenant(tenantId, (tx) =>
      Promise.all([
        tx.message.count({ where: { tenantId, createdAt: { gte: since } } }),
        tx.message.count({
          where: {
            tenantId,
            role: MessageRole.ASSISTANT,
            status: { not: 'FAILED' },
            createdAt: { gte: since },
          },
        }),
        tx.conversation.count({
          where: {
            tenantId,
            status: {
              in: [
                ConversationStatus.BOT,
                ConversationStatus.HANDOFF,
                ConversationStatus.HUMAN,
              ],
            },
          },
        }),
        // Conversations started in the range that a human ended up touching.
        // Counted from the event log rather than the current `status` column,
        // because a conversation can be escalated and later resolved.
        tx.conversation.count({
          where: {
            tenantId,
            createdAt: { gte: since },
            events: {
              some: {
                type: {
                  in: ['conversation.escalated', 'conversation.taken-over'],
                },
              },
            },
          },
        }),
        tx.llmUsage.aggregate({
          where: { tenantId, createdAt: { gte: since } },
          _sum: { tokensIn: true, tokensOut: true },
          _count: true,
        }),
        tx.llmUsage.findMany({
          where: {
            tenantId,
            createdAt: { gte: since },
            latencyMs: { not: null },
          },
          select: { latencyMs: true },
        }),
        tx.conversation.groupBy({
          by: ['channel'],
          where: { tenantId, createdAt: { gte: since } },
          _count: { channel: true },
        }),
        tx.message.findMany({
          where: {
            tenantId,
            role: MessageRole.CUSTOMER,
            createdAt: { gte: since },
          },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
      ]),
    );
    const latency = latencyRows
      .map((row) => row.latencyMs!)
      .sort((a, b) => a - b);
    const totalTokens =
      (usage._sum.tokensIn ?? 0) + (usage._sum.tokensOut ?? 0);
    // Denominator for both rates: conversations opened in this range. The
    // previous implementation divided conversation counts by message counts,
    // which mixed units and produced percentages with no meaning.
    const conversationsStarted = byChannel.reduce(
      (sum, item) => sum + item._count.channel,
      0,
    );
    return {
      range,
      metrics: {
        totalMessages,
        assistantMessages,
        conversationsStarted,
        // Share of new conversations the bot handled without a human stepping in.
        aiResolvedRate: conversationsStarted
          ? Number(
              (
                ((conversationsStarted - escalatedConversations) /
                  conversationsStarted) *
                100
              ).toFixed(1),
            )
          : 0,
        activeConversations,
        escalationRate: conversationsStarted
          ? Number(
              ((escalatedConversations / conversationsStarted) * 100).toFixed(
                1,
              ),
            )
          : 0,
        averageResponseMs: latency.length
          ? Math.round(
              latency.reduce((sum, value) => sum + value, 0) / latency.length,
            )
          : null,
        p50LatencyMs: percentile(latency, 0.5),
        p95LatencyMs: percentile(latency, 0.95),
        customerSatisfaction: null,
        tokenUsage: totalTokens,
      },
      channels: byChannel.map((item) => ({
        channel: item.channel,
        count: item._count.channel,
        // Percentage of conversations, not of messages.
        percentage: conversationsStarted
          ? Number(
              ((item._count.channel / conversationsStarted) * 100).toFixed(1),
            )
          : 0,
      })),
      messageFlow: bucketMessages(
        recentMessages.map((message) => message.createdAt),
        range,
      ),
      unavailableMetrics: ['customerSatisfaction'],
    };
  }

  async dashboard(tenantId: string) {
    const [analytics, providers, usage, activity] = await Promise.all([
      this.analytics(tenantId, '24h'),
      this.providers.list(tenantId),
      this.usage(tenantId),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.auditLog.findMany({
          where: { tenantId },
          orderBy: { createdAt: 'desc' },
          take: 8,
          select: { action: true, details: true, createdAt: true },
        }),
      ),
    ]);
    return { ...analytics, providers, usage, activity };
  }

  async usage(tenantId: string) {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const [settings, providerRows, history] = await this.prisma.withTenant(
      tenantId,
      (tx) =>
        Promise.all([
          tx.tenantSettings.findUniqueOrThrow({ where: { tenantId } }),
          tx.llmUsage.groupBy({
            by: ['provider', 'model'],
            where: { tenantId, createdAt: { gte: start } },
            _sum: { tokensIn: true, tokensOut: true },
            _count: true,
          }),
          tx.llmUsage.findMany({
            where: { tenantId },
            orderBy: { createdAt: 'desc' },
            take: 50,
            select: {
              provider: true,
              model: true,
              tokensIn: true,
              tokensOut: true,
              outcome: true,
              latencyMs: true,
              createdAt: true,
            },
          }),
        ]),
    );
    const providers = await this.providers.list(tenantId);
    const configured = providers.map((provider) => {
      const row = providerRows.find(
        (item) =>
          item.provider.toLowerCase() === provider.provider.toLowerCase() &&
          item.model === provider.model,
      );
      const tokens = (row?._sum.tokensIn ?? 0) + (row?._sum.tokensOut ?? 0);
      return {
        ...provider,
        requestsToday: row?._count ?? 0,
        tokensToday: tokens,
        status: !provider.enabled
          ? 'inactive'
          : provider.configured
            ? 'ready'
            : 'missing-credentials',
      };
    });
    const tokensToday = configured.reduce(
      (sum, provider) => sum + provider.tokensToday,
      0,
    );
    const dailyTokenBudget = settings.dailyTokenBudget;
    const budgetUsedPercent = dailyTokenBudget
      ? Number(((tokensToday / dailyTokenBudget) * 100).toFixed(1))
      : 0;
    return {
      tokensToday,
      requestsToday: configured.reduce(
        (sum, provider) => sum + provider.requestsToday,
        0,
      ),
      dailyTokenBudget,
      budgetUsedPercent,
      alertThreshold: settings.alertThreshold,
      // alertThreshold and autoThrottle were previously stored but never
      // evaluated against anything, so both were inert settings.
      alertTriggered:
        dailyTokenBudget > 0 && budgetUsedPercent >= settings.alertThreshold,
      autoThrottle: settings.autoThrottle,
      providers: configured,
      history,
      // Converting tokens to currency needs a per-model price list this service
      // does not have, so cost is reported as unavailable instead of as a fake 0.
      unavailableMetrics: ['costUsd'],
    };
  }

  async insights(tenantId: string) {
    const [analytics, sources] = await Promise.all([
      this.analytics(tenantId, '7d'),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.knowledgeSource.count({ where: { tenantId, status: 'READY' } }),
      ),
    ]);
    const insights = [] as Array<{
      id: string;
      type: string;
      impact: string;
      title: string;
      description: string;
      action?: string;
    }>;
    if (!sources)
      insights.push({
        id: 'knowledge-empty',
        type: 'warning',
        impact: 'high',
        title: 'Knowledge Base Empty',
        description:
          'Upload FAQs or product documents before enabling customer auto-replies.',
        action: 'Add Source',
      });
    if (analytics.metrics.escalationRate > 20)
      insights.push({
        id: 'escalations',
        type: 'knowledge-gap',
        impact: 'high',
        title: 'Knowledge Gap Detected',
        description: `${analytics.metrics.escalationRate}% of recent customer messages were escalated. Review the unanswered questions list.`,
        action: 'View Unanswered',
      });
    if (analytics.metrics.p95LatencyMs && analytics.metrics.p95LatencyMs > 4000)
      insights.push({
        id: 'latency',
        type: 'warning',
        impact: 'medium',
        title: 'AI Latency Elevated',
        description: `p95 response latency is ${analytics.metrics.p95LatencyMs}ms. Check provider health and quotas.`,
        action: 'View Budget',
      });
    if (!insights.length)
      insights.push({
        id: 'healthy',
        type: 'success',
        impact: 'positive',
        title: 'System Healthy',
        description:
          'No significant knowledge, quota, or latency risks were detected in this range.',
      });
    return {
      range: '7d',
      insights,
      trends: analytics.metrics,
      topTopics: [],
      capabilities: {
        knowledgeGapDetector: 'derived-mvp',
        aiCoach: 'unavailable',
      },
    };
  }

  async topUnanswered(tenantId: string, range = '30d') {
    const since = new Date(Date.now() - (RANGE_MS[range] ?? RANGE_MS['30d']));
    const messages = await this.prisma.withTenant(tenantId, (tx) =>
      tx.message.findMany({
        where: {
          tenantId,
          role: MessageRole.CUSTOMER,
          createdAt: { gte: since },
          conversation: { status: ConversationStatus.HANDOFF },
        },
        orderBy: { createdAt: 'desc' },
        take: 250,
        select: { content: true, createdAt: true },
      }),
    );
    const grouped = new Map<
      string,
      { question: string; count: number; lastAskedAt: Date }
    >();
    for (const message of messages) {
      const question = message.content
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 240);
      const key = question.toLowerCase();
      const existing = grouped.get(key);
      grouped.set(key, {
        question,
        count: (existing?.count ?? 0) + 1,
        lastAskedAt:
          existing?.lastAskedAt && existing.lastAskedAt > message.createdAt
            ? existing.lastAskedAt
            : message.createdAt,
      });
    }
    return [...grouped.values()].sort((a, b) => b.count - a.count).slice(0, 20);
  }
}

function percentile(values: number[], ratio: number): number | null {
  if (!values.length) return null;
  return values[
    Math.min(
      values.length - 1,
      Math.max(0, Math.ceil(values.length * ratio) - 1),
    )
  ];
}

function bucketMessages(dates: Date[], range: string) {
  const buckets = new Map<string, number>();
  const hours = range === '24h' ? 4 : 24;
  for (const date of dates) {
    const bucket = `${date.toISOString().slice(0, 13 - (hours === 4 ? 0 : 3))}`;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  // The web client renders `messageFlow[].timestamp` — keep the key name in
  // sync so charts receive real ISO datetimes instead of `undefined`.
  return [...buckets.entries()]
    .map(([bucket, count]) => ({
      timestamp:
        bucket.length === 10
          ? `${bucket}T00:00:00.000Z`
          : `${bucket}:00:00.000Z`,
      count,
    }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
