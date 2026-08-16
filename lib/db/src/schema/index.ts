import { pgTable, text, timestamp, integer, primaryKey } from "drizzle-orm/pg-core";

export const guilds = pgTable("guilds", {
  guildId: text("guild_id").primaryKey(),
  name: text("name").notNull().default("Bilinmiyor"),
  ownerId: text("owner_id"),
  memberCount: integer("member_count"),
  knowledge: text("knowledge"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userProfiles = pgTable("user_profiles", {
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  username: text("username"),
  displayName: text("display_name"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.guildId, table.userId] }),
}));
