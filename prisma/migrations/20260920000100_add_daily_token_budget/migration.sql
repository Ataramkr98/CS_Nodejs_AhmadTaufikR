-- `alertThreshold` and `autoThrottle` already existed on TenantSettings but had
-- nothing to be measured against, so both were inert. This adds the token budget
-- they compare today's real token consumption to.
ALTER TABLE "TenantSettings" ADD COLUMN "dailyTokenBudget" INTEGER NOT NULL DEFAULT 1000000;
