import { pgTable, bigserial, integer, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const botShopStateTable = pgTable("bot_shop_state", {
  id: integer("id").primaryKey(),
  state: jsonb("state").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const botGuildSettingsTable = pgTable("bot_guild_settings", {
  guildId: text("guild_id").primaryKey(),
  settings: jsonb("settings").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiConversationHistoryTable = pgTable("ai_conversation_history", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  guildId: text("guild_id"),
  channelId: text("channel_id").notNull(),
  userId: text("user_id").notNull(),
  username: text("username"),
  prompt: text("prompt").notNull(),
  response: text("response").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
