# Database (Prisma + Supabase)

## Render: `FATAL: tenant/user postgres.<ref> not found`

This means **`DATABASE_URL` on Render does not match** what Supabase expects for the **transaction pooler**.

1. In **Supabase** → **Project Settings** → **Database**, copy the **Transaction** pooler URI (port **6543**).
2. In **Render** → your backend service → **Environment**, set:
   - **`DATABASE_URL`** — transaction pooler, e.g.  
     `postgresql://postgres.woumhfvlifirgbesizkw:PASSWORD@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true`
   - **`DIRECT_URL`** — direct or session pooler on port **5432** (for `prisma db push` / migrations).
3. **Username** must be `postgres.<project-ref>` (with a dot), **not** plain `postgres`.
4. **Host** must be `aws-0-<region>.pooler.supabase.com`, **not** `db.<ref>.supabase.co` on port 6543.
5. **URL-encode** the database password in the URL (`$` → `%24`, `#` → `%23`, `@` → `%40`).
6. **Pooler hostname** must be copied from the dashboard — it is not always `aws-0-<region>.pooler.supabase.com`. Newer projects may use `aws-1-us-east-2.pooler.supabase.com` etc. Wrong host → same “tenant/user not found” error.

After changing env vars, **redeploy** the Render service. On startup the backend logs `[database] DATABASE_URL` with host, port, and user (no password).

Alternatively set **`SUPABASE_PROJECT_REF`**, **`SUPABASE_DB_PASSWORD`**, and either:

- **`SUPABASE_POOLER_HOST`** — exact host from the dashboard (recommended), or  
- **`SUPABASE_REGION`** — only if your dashboard host is `aws-0-<region>.pooler.supabase.com`

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
