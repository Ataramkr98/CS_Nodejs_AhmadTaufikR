-- NULL keeps the existing priority-based router. A preferred model is tried
-- first, with the other enabled providers retained as fallbacks.
ALTER TABLE "TenantSettings" ADD COLUMN "autoReplyModel" TEXT;
