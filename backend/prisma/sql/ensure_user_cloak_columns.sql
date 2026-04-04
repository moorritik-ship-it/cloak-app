-- Idempotent: safe to run in Supabase SQL editor or via prisma db execute.
-- Fixes missing columns if db push targeted a pooler or drift occurred.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "cloak_streak_days" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_daily_reward_ist_date" VARCHAR(10);
