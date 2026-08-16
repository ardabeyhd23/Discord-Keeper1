import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set. Add your Render PostgreSQL connection string.");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export const db = drizzle(pool, { schema });

export async function initDatabase(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guilds (
      guild_id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Bilinmiyor',
      owner_id TEXT,
      member_count INTEGER,
      knowledge TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS moderation_cases (
      case_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      category TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      reason TEXT NOT NULL,
      timeout_until TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      appeal_requested BOOLEAN NOT NULL DEFAULT FALSE,
      appeal_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS moderation_cases_user_idx
      ON moderation_cases (guild_id, user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS user_profiles (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT,
      display_name TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (guild_id, user_id)
    );
  `);
}

export * from "./schema";
