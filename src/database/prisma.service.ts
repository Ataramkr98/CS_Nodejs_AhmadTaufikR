import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async withTenant<T>(
    tenantId: string,
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.current_tenant', ${tenantId}, true)`,
      );
      return callback(tx);
    });
  }

  async withLoginEmail<T>(
    email: string,
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.auth_email', ${email.toLowerCase()}, true)`,
      );
      return callback(tx);
    });
  }

  async withWidgetKey<T>(
    widgetKey: string,
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.widget_key', ${widgetKey}, true)`,
      );
      return callback(tx);
    });
  }
}
