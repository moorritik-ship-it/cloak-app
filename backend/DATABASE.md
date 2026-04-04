# Database (Prisma + Supabase)

## `cloak_streak_days` missing but `db push` says “in sync”

The `User` model fields `cloakStreakDays` / `last_daily_reward_ist_date` are defined in `prisma/schema.prisma`. If the column is still missing in Postgres:

1. **Use the direct Supabase URL for migrations**  
   In `.env`, set **`DIRECT_URL`** to the **direct** Postgres connection (port **5432**, not the pooler on **6543**). Prisma uses `directUrl` for `db push` / migrations. If `DIRECT_URL` is wrong or points at the pooler, DDL can fail or behave oddly.

2. **Apply columns manually (idempotent)**  
   In Supabase → **SQL Editor**, run:

   `prisma/sql/ensure_user_cloak_columns.sql`

   Or from the backend folder:

   ```bash
   npx prisma db execute --file prisma/sql/ensure_user_cloak_columns.sql --schema prisma/schema.prisma
   ```

3. **Re-sync**

   ```bash
   npx prisma db push
   npx prisma generate
   ```

   Stop the Node server first on Windows if `prisma generate` hits `EPERM` on the query engine DLL.
