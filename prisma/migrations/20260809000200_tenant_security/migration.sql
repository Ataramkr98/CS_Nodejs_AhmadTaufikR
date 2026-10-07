-- Defense-in-depth tenant isolation. The API sets app.current_tenant in every
-- transaction and still applies an explicit tenantId predicate in repositories.
CREATE INDEX IF NOT EXISTS "KnowledgeChunk_embedding_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw (embedding vector_cosine_ops);

ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Tenant" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Tenant"
  USING ("id" = current_setting('app.current_tenant', true))
  WITH CHECK ("id" = current_setting('app.current_tenant', true));
CREATE POLICY public_widget_lookup ON "Tenant" FOR SELECT
  USING ("widgetKey" = current_setting('app.widget_key', true));

ALTER TABLE "TenantSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantSettings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_settings_isolation ON "TenantSettings"
  USING ("tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true));

ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_tenant_isolation ON "User"
  USING ("tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true));
-- Login can read exactly the email it is authenticating; all normal user
-- access still requires the tenant policy above.
CREATE POLICY user_login_lookup ON "User" FOR SELECT
  USING ("email" = current_setting('app.auth_email', true));

ALTER TABLE "RefreshToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RefreshToken" FORCE ROW LEVEL SECURITY;
CREATE POLICY refresh_token_tenant_isolation ON "RefreshToken"
  USING ("tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true));

ALTER TABLE "ApiKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApiKey" FORCE ROW LEVEL SECURITY;
CREATE POLICY api_key_tenant_isolation ON "ApiKey"
  USING ("tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true));

ALTER TABLE "TenantProviderConfig" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantProviderConfig" FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_config_tenant_isolation ON "TenantProviderConfig"
  USING ("tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true));

ALTER TABLE "KnowledgeSource" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KnowledgeSource" FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_source_tenant_isolation ON "KnowledgeSource"
  USING ("tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true));

ALTER TABLE "KnowledgeChunk" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KnowledgeChunk" FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_chunk_tenant_isolation ON "KnowledgeChunk"
  USING ("tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true));

ALTER TABLE "Customer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Customer" FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_tenant_isolation ON "Customer"
  USING ("tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true));

ALTER TABLE "Conversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Conversation" FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_tenant_isolation ON "Conversation"
  USING ("tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true));

ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Message" FORCE ROW LEVEL SECURITY;
CREATE POLICY message_tenant_isolation ON "Message"
  USING ("tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true));

ALTER TABLE "MessageCitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MessageCitation" FORCE ROW LEVEL SECURITY;
CREATE POLICY message_citation_tenant_isolation ON "MessageCitation"
  USING (EXISTS (
    SELECT 1 FROM "Message" m
    WHERE m.id = "messageId"
      AND m."tenantId" = current_setting('app.current_tenant', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "Message" m
    WHERE m.id = "messageId"
      AND m."tenantId" = current_setting('app.current_tenant', true)
  ));

ALTER TABLE "ConversationEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConversationEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_event_tenant_isolation ON "ConversationEvent"
  USING (EXISTS (
    SELECT 1 FROM "Conversation" c
    WHERE c.id = "conversationId"
      AND c."tenantId" = current_setting('app.current_tenant', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "Conversation" c
    WHERE c.id = "conversationId"
      AND c."tenantId" = current_setting('app.current_tenant', true)
  ));

ALTER TABLE "LlmUsage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LlmUsage" FORCE ROW LEVEL SECURITY;
CREATE POLICY usage_tenant_isolation ON "LlmUsage"
  USING ("tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true));

ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log_tenant_isolation ON "AuditLog"
  USING ("tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true));
