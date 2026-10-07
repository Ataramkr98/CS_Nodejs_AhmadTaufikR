-- Additive only: registers the shared OpenAI-compatible AI gateway as a new
-- provider kind. Existing rows and enum values are untouched, so providers that
-- a tenant already enabled keep their configuration and priority.
ALTER TYPE "ProviderKind" ADD VALUE IF NOT EXISTS 'AUTOAPP';
