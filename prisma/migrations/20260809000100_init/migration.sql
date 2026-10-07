-- CSP requires pgvector before the generated KnowledgeChunk table is created.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'AGENT', 'ADMIN', 'VIEWER');

-- CreateEnum
CREATE TYPE "ProviderKind" AS ENUM ('GROQ', 'GEMINI', 'OPENROUTER', 'OLLAMA', 'DEMO');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('TEXT', 'PDF', 'DOCX', 'MARKDOWN');

-- CreateEnum
CREATE TYPE "SourceStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'DELETED');

-- CreateEnum
CREATE TYPE "ConversationChannel" AS ENUM ('WEB', 'WHATSAPP', 'EMAIL', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('BOT', 'HANDOFF', 'HUMAN', 'RESOLVED', 'FAILED');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('CUSTOMER', 'ASSISTANT', 'AGENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('PENDING', 'STREAMING', 'SENT', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "widgetKey" TEXT NOT NULL,
    "allowedOrigins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantSettings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Jakarta',
    "language" TEXT NOT NULL DEFAULT 'id',
    "brandVoice" TEXT NOT NULL DEFAULT 'Ramah, profesional, dan selalu jawab berdasarkan knowledge base.',
    "businessHours" TEXT NOT NULL DEFAULT '09:00-21:00',
    "escalationThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.65,
    "autoReplyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "streamingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "citationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailNotifications" BOOLEAN NOT NULL DEFAULT true,
    "pushNotifications" BOOLEAN NOT NULL DEFAULT false,
    "weeklyReports" BOOLEAN NOT NULL DEFAULT true,
    "autoThrottle" BOOLEAN NOT NULL DEFAULT true,
    "alertThreshold" INTEGER NOT NULL DEFAULT 80,
    "embeddingModel" TEXT NOT NULL DEFAULT 'nomic-embed-text-v1.5',
    "embeddingVersion" TEXT NOT NULL DEFAULT '1',

    CONSTRAINT "TenantSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT,
    "googleId" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'OWNER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantProviderConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" "ProviderKind" NOT NULL,
    "model" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "dailyLimit" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantProviderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeSource" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "SourceType" NOT NULL,
    "mimeType" TEXT,
    "filename" TEXT,
    "storagePath" TEXT,
    "content" TEXT,
    "status" "SourceStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "byteSize" INTEGER NOT NULL DEFAULT 0,
    "indexedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "embedding" vector(768),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT,
    "channel" "ConversationChannel" NOT NULL DEFAULT 'WEB',
    "status" "ConversationStatus" NOT NULL DEFAULT 'BOT',
    "subject" TEXT,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "role" "MessageRole" NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'SENT',
    "content" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "confidence" DOUBLE PRECISION,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageCitation" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageCitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationEvent" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmUsage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "outcome" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_widgetKey_key" ON "Tenant"("widgetKey");

-- CreateIndex
CREATE UNIQUE INDEX "TenantSettings_tenantId_key" ON "TenantSettings"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- CreateIndex
CREATE INDEX "User_tenantId_role_idx" ON "User"("tenantId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_expiresAt_idx" ON "RefreshToken"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_tenantId_revokedAt_idx" ON "ApiKey"("tenantId", "revokedAt");

-- CreateIndex
CREATE INDEX "TenantProviderConfig_tenantId_enabled_priority_idx" ON "TenantProviderConfig"("tenantId", "enabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "TenantProviderConfig_tenantId_provider_model_key" ON "TenantProviderConfig"("tenantId", "provider", "model");

-- CreateIndex
CREATE INDEX "KnowledgeSource_tenantId_status_updatedAt_idx" ON "KnowledgeSource"("tenantId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_tenantId_sourceId_idx" ON "KnowledgeChunk"("tenantId", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeChunk_sourceId_ordinal_key" ON "KnowledgeChunk"("sourceId", "ordinal");

-- CreateIndex
CREATE INDEX "Customer_tenantId_externalId_idx" ON "Customer"("tenantId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_tenantId_email_key" ON "Customer"("tenantId", "email");

-- CreateIndex
CREATE INDEX "Conversation_tenantId_status_lastMessageAt_idx" ON "Conversation"("tenantId", "status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Conversation_tenantId_channel_lastMessageAt_idx" ON "Conversation"("tenantId", "channel", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Message_tenantId_conversationId_createdAt_idx" ON "Message"("tenantId", "conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "MessageCitation_messageId_idx" ON "MessageCitation"("messageId");

-- CreateIndex
CREATE INDEX "ConversationEvent_conversationId_createdAt_idx" ON "ConversationEvent"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "LlmUsage_tenantId_createdAt_idx" ON "LlmUsage"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "LlmUsage_tenantId_provider_createdAt_idx" ON "LlmUsage"("tenantId", "provider", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "TenantSettings" ADD CONSTRAINT "TenantSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantProviderConfig" ADD CONSTRAINT "TenantProviderConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageCitation" ADD CONSTRAINT "MessageCitation_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationEvent" ADD CONSTRAINT "ConversationEvent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LlmUsage" ADD CONSTRAINT "LlmUsage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

