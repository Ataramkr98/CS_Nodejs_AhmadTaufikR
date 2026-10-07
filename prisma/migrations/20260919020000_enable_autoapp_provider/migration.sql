-- Activate the shared AI gateway (AUTOAPP) for every tenant that already
-- exists, so existing workspaces route through it without a manual API call.
--
-- minimax-m3 is the primary route and glm-5.3-flash the automatic failover;
-- both are the two cheapest models. kimi-k3 is seeded but left disabled because
-- it is the most expensive fallback — a tenant opts in explicitly.
--
-- Idempotent: ON CONFLICT DO NOTHING means re-running never duplicates rows and
-- never overrides a tenant that already tuned these entries by hand.
INSERT INTO "TenantProviderConfig"
  (id, "tenantId", provider, model, enabled, priority, "createdAt", "updatedAt")
SELECT
  md5(random()::text || clock_timestamp()::text || t.id || m.model),
  t.id,
  m.provider::"ProviderKind",
  m.model,
  m.enabled,
  m.priority,
  now(),
  now()
FROM "Tenant" t
CROSS JOIN (
  VALUES
    ('AUTOAPP', 'minimax-m3', true, 1),
    ('AUTOAPP', 'glm-5.3-flash', true, 2),
    ('AUTOAPP', 'kimi-k3', false, 3)
) AS m(provider, model, enabled, priority)
ON CONFLICT ("tenantId", provider, model) DO NOTHING;
