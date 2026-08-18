import { logger } from "./lib/logger";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";

const DISCORD_API = "https://discord.com/api/v10";
const FR_SHOP_ACTIVITY_URL = process.env.FR_SHOP_ACTIVITY_URL?.trim() || "";
const GATEWAY_VERSION = 10;
const MESSAGE_CONTENT_INTENT = 1 << 15;
const GUILDS_INTENT = 1;
const GUILD_MEMBERS_INTENT = 1 << 1;
const GUILD_MESSAGES_INTENT = 1 << 9;
const DIRECT_MESSAGES_INTENT = 1 << 12;
const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;
const LINK_PATTERN = /(?:https?:\/\/|www\.|discord\.gg\/|t\.me\/|bit\.ly\/)/i;
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>()]+/gi;
const MEDIA_FILE_URL_PATTERN = /\.(?:gif|png|jpe?g|webp|avif)(?:[?#][^\s<>()]*)?$/i;
const GIF_HOST_PATTERN = /(?:^|\.)((?:media\.)?giphy\.com|giphy\.com|tenor\.com|media\.tenor\.com|imgur\.com|i\.imgur\.com)$/i;

type JsonRecord = Record<string, any>;
type ModerationCategory = "link" | "argo" | "kufur" | "kavga" | "cinsel" | "gorsel";
type ClassificationCategory = "clean" | "argo" | "kufur" | "kavga" | "cinsel";

interface RawWebSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((error: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

interface ModerationCase {
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  username?: string;
  displayName?: string;
  category: ModerationCategory;
  durationMs: number;
  reason: string;
  timeoutUntil: string;
  dmChannelId?: string;
  status: "pending" | "accepted" | "rejected" | "challenge";
  appealRequested?: boolean;
  frArdaUserId?: string;
  challengeAnswer?: number;
  challengeMessageId?: string;
  appealReason?: string;
  responseTimer?: ReturnType<typeof setTimeout>;
  challengeOptions?: string[];
  challengeQuestion?: string;
}

interface SuggestionCase {
  id: string;
  guildId: string;
  sourceChannelId: string;
  userId: string;
  username: string;
  displayName: string;
  suggestion: string;
  ownerId: string;
  ownerDmChannelId?: string;
  status: "pending" | "approved" | "rejected";
  rejectionReason?: string;
  published?: boolean;
}

const guildLinkPermissions = new Map<string, boolean>();
const guildLinkAllowedUsers = new Map<string, Set<string>>();
const guildKnowledgeCache = new Map<string, { knowledge: string; expiresAt: number }>();
const GUILD_KNOWLEDGE_TTL_MS = 5 * 60_000;
const userProfileCache = new Map<string, { username: string; displayName: string; lastSeenAt: number }>();
const moderationCases = new Map<string, ModerationCase>();
const suggestionCases = new Map<string, SuggestionCase>();
const heartedMessages = new Set<string>();
const registeredCommandGuilds = new Set<string>();
const welcomeDmSent = new Set<string>();
const welcomeDmInFlight = new Map<string, Promise<void>>();
let frArdaBotId = "";
const frArdaCache = new Map<
  string,
  { member: JsonRecord | null; expiresAt: number }
>();
const channelNameCache = new Map<string, string>();


// FR Family Shop — kullanıcı bazlı coin ve sipariş sistemi.
// Render yeniden başlatıldığında da mümkün olduğunca korunması için yerel JSON dosyası kullanılır.
// Kalıcı harici DB eklendiğinde bu katman kolayca değiştirilebilir.
interface ShopUserState { coins: number; }
interface ShopOrder {
  id: string;
  guildId: string;
  userId: string;
  username: string;
  displayName: string;
  product: string;
  price: number;
  status: "devam-ediyor" | "tamamlandi" | "iptal";
  createdAt: string;
}
interface ShopState {
  users: Record<string, ShopUserState>;
  orders: ShopOrder[];
  lastCampaignAt: Record<string, string>;
  campaignDiscount: Record<string, number>;
  campaignExpiresAt: Record<string, string>;
  // Yönetici tarafından mağazaya eklenen üst roller: guildId -> roleId -> fiyat.
  shopCatalog: Record<string, Record<string, number>>;
  shopMessageIds: Record<string, string[]>;
}
// Coin/shop verisi Render yeniden başlatmalarında da korunabilsin diye
// SHOP_DATA_DIR kullanılabilir. Render blueprint bu dizini kalıcı diske bağlar.
const shopDataDir = process.env.SHOP_DATA_DIR?.trim() || path.join(process.cwd(), "data");
const shopStatePath = path.join(shopDataDir, "fr-family-shop.json");
let shopState: ShopState = { users: {}, orders: [], lastCampaignAt: {}, campaignDiscount: {}, campaignExpiresAt: {}, shopCatalog: {}, shopMessageIds: {} };
let shopStateLoaded = false;
let shopStateLoadPromise: Promise<void> | null = null;
let shopStateWriteQueue: Promise<void> = Promise.resolve();
const shopTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activeShopSessions = new Map<string, { guildId: string; applicationId: string; token: string; updatedAt: number }>();
const FRARDA_CONTACT_ID = "1231243551053053982";
const SHOP_ROLE_PRICE_DEFAULT = 5_000;
const SHOP_SPECIAL_ROLE_PRICE = 10_000;
const SHOP_NITRO_PRICE = 100_000;
const SHOP_CAMPAIGN_INTERVAL_MS = 5 * 24 * 60 * 60 * 1000;
const SHOP_CAMPAIGN_DURATION_MS = 2 * 24 * 60 * 60 * 1000;
const SHOP_CAMPAIGN_DISCOUNTS = [10, 15, 20, 25, 30, 35, 40, 50] as const;

let dbInitPromise: Promise<boolean> | null = null;
let dbPool: any = null;

async function getDatabasePool(): Promise<any | null> {
  if (!process.env.DATABASE_URL?.trim()) return null;
  if (dbPool) return dbPool;
  try {
    const mod = await import("@workspace/db");
    dbPool = mod.pool;
    return dbPool;
  } catch (error) {
    logger.warn({ err: error }, "PostgreSQL bağlantısı kullanılamıyor; dosya kayıtları kullanılacak");
    return null;
  }
}

async function ensureDatabase(): Promise<boolean> {
  if (dbInitPromise) return dbInitPromise;
  dbInitPromise = (async () => {
    const pool = await getDatabasePool();
    if (!pool) return false;
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS bot_shop_state (
          id integer PRIMARY KEY,
          state jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS bot_guild_settings (
          guild_id text PRIMARY KEY,
          settings jsonb NOT NULL DEFAULT '{}'::jsonb,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS ai_conversation_history (
          id bigserial PRIMARY KEY,
          guild_id text,
          channel_id text NOT NULL,
          user_id text NOT NULL,
          username text,
          prompt text NOT NULL,
          response text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS ai_conversation_history_user_idx
          ON ai_conversation_history (user_id, created_at DESC);
      `);
      return true;
    } catch (error) {
      logger.warn({ err: error }, "PostgreSQL tabloları hazırlanamadı; dosya kayıtları kullanılacak");
      return false;
    }
  })();
  return dbInitPromise;
}

async function saveAiConversation(
  message: JsonRecord,
  prompt: string,
  response: string,
): Promise<void> {
  if (!prompt || !response) return;
  try {
    const pool = await getDatabasePool();
    if (!pool) return;
    const author = (message.author ?? {}) as JsonRecord;
    await pool.query(
      `INSERT INTO ai_conversation_history
       (guild_id, channel_id, user_id, username, prompt, response)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        message.guild_id ? String(message.guild_id) : null,
        String(message.channel_id ?? ""),
        String(author.id ?? ""),
        String(author.global_name ?? author.username ?? "Kullanıcı"),
        prompt.slice(0, 8000),
        response.slice(0, 8000),
      ],
    );
  } catch (error) {
    logger.warn({ err: error }, "AI konuşma geçmişi PostgreSQL'e kaydedilemedi");
  }
}

async function getAiHistory(userId: string, limit = 12): Promise<JsonRecord[]> {
  try {
    const pool = await getDatabasePool();
    if (!pool) return [];
    const result = await pool.query(
      `SELECT prompt, response, created_at
       FROM ai_conversation_history
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, Math.min(20, Math.max(1, limit))],
    );
    return result.rows as JsonRecord[];
  } catch (error) {
    logger.warn({ err: error }, "AI konuşma geçmişi okunamadı");
    return [];
  }
}

async function saveGuildSettings(guildId: string): Promise<void> {
  try {
    const pool = await getDatabasePool();
    if (!pool || !guildId) return;
    const settings = {
      linkEnabled: guildLinkPermissions.get(guildId) ?? false,
      allowedLinkUsers: [...getAllowedLinkUsers(guildId)],
    };
    await pool.query(
      `INSERT INTO bot_guild_settings (guild_id, settings, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (guild_id) DO UPDATE
       SET settings = EXCLUDED.settings, updated_at = now()`,
      [guildId, JSON.stringify(settings)],
    );
  } catch (error) {
    logger.warn({ err: error, guildId }, "Sunucu ayarları PostgreSQL'e kaydedilemedi");
  }
}

async function loadGuildSettings(guildId: string): Promise<void> {
  try {
    const pool = await getDatabasePool();
    if (!pool || !guildId) return;
    const result = await pool.query(
      `SELECT settings FROM bot_guild_settings WHERE guild_id = $1`,
      [guildId],
    );
    const settings = (result.rows[0]?.settings ?? {}) as JsonRecord;
    if (typeof settings.linkEnabled === "boolean") {
      guildLinkPermissions.set(guildId, settings.linkEnabled);
    }
    if (Array.isArray(settings.allowedLinkUsers)) {
      guildLinkAllowedUsers.set(guildId, new Set(settings.allowedLinkUsers.map(String)));
    }
  } catch (error) {
    logger.warn({ err: error, guildId }, "Sunucu ayarları PostgreSQL'den okunamadı");
  }
}

async function saveShopStateToDatabase(): Promise<void> {
  try {
    const pool = await getDatabasePool();
    if (!pool) return;
    await pool.query(
      `INSERT INTO bot_shop_state (id, state, updated_at)
       VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      [JSON.stringify(shopState)],
    );
  } catch (error) {
    logger.warn({ err: error }, "Shop verileri PostgreSQL'e kaydedilemedi");
  }
}

async function loadShopStateFromDatabase(): Promise<boolean> {
  try {
    const pool = await getDatabasePool();
    if (!pool) return false;
    const result = await pool.query(`SELECT state FROM bot_shop_state WHERE id = 1`);
    if (!result.rows[0]?.state) return false;
    const parsed = result.rows[0].state as Partial<ShopState>;
    shopState = {
      users: parsed.users ?? {},
      orders: parsed.orders ?? [],
      lastCampaignAt: parsed.lastCampaignAt ?? {},
      campaignDiscount: parsed.campaignDiscount ?? {},
      campaignExpiresAt: parsed.campaignExpiresAt ?? {},
      shopCatalog: parsed.shopCatalog ?? {},
      shopMessageIds: parsed.shopMessageIds ?? {},
    };
    return true;
  } catch (error) {
    logger.warn({ err: error }, "Shop verileri PostgreSQL'den okunamadı");
    return false;
  }
}


// FR Family Shop'ta satılabilecek roller. Discord'daki görünen isimleri temel alır;
// rol sırası Discord'dan otomatik olarak korunur. İSTEK ÖNERİ & ŞİKAYET gibi
// normal/işlevsel roller mağazaya alınmaz.
const SHOP_ROLE_PRICES: Record<string, number> = {
  "FR | EMPEROR": 50_000,
  "FR | KING": 40_000,
  "FR | ROBUX MANYAĞI": 25_000,
  "FR | AYYILDIZ": 20_000,
  "FR | ELITE": 30_000,
  "FR | VİP": 15_000,
};

function normalizedShopRoleName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[♛♕⚕]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleUpperCase("tr-TR");
}

const SHOP_ALLOWED_ROLES = new Set([
  "FR | EMPEROR",
  "FR | KING",
  "FR | ROBUX MANYAGI",
  "FR | AYYILDIZ",
  "FR | ELITE",
  "FR | VIP",
]);

function isShopRole(role: JsonRecord): boolean {
  if (String(role.name ?? "") === "@everyone" || role.managed || Number(role.position ?? 0) <= 0) return false;
  return SHOP_ALLOWED_ROLES.has(normalizedShopRoleName(String(role.name ?? "")));
}

function isCatalogShopRole(guildId: string, role: JsonRecord): boolean {
  const roleId = String(role.id ?? "");
  return Boolean(roleId && Number(shopState.shopCatalog[guildId]?.[roleId] ?? 0) > 0);
}

async function loadShopState(): Promise<void> {
  if (shopStateLoaded) return;
  if (shopStateLoadPromise) return shopStateLoadPromise;

  shopStateLoadPromise = (async () => {
    try {
      const raw = await readFile(shopStatePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ShopState>;
      shopState = {
        users: parsed.users ?? {},
        orders: parsed.orders ?? [],
        lastCampaignAt: parsed.lastCampaignAt ?? {},
        campaignDiscount: parsed.campaignDiscount ?? {},
        campaignExpiresAt: parsed.campaignExpiresAt ?? {},
        shopCatalog: parsed.shopCatalog ?? {},
        shopMessageIds: parsed.shopMessageIds ?? {},
      };
    } catch {
      // İlk çalıştırma veya kalıcı diskte henüz dosya yoksa temiz başlangıç.
    } finally {
      shopStateLoaded = true;
      shopStateLoadPromise = null;
    }
    await ensureDatabase();
    const loadedFromDatabase = await loadShopStateFromDatabase();
    if (!loadedFromDatabase && Object.keys(shopState.users).length + shopState.orders.length > 0) {
      await saveShopStateToDatabase();
    }
  })();

  return shopStateLoadPromise;
}

async function saveShopState(): Promise<boolean> {
  // Aynı anda gelen coin/sipariş/kampanya kayıtları birbirinin JSON dosyasını ezmesin.
  let result = false;
  shopStateWriteQueue = shopStateWriteQueue.then(async () => {
    try {
      await mkdir(path.dirname(shopStatePath), { recursive: true });
      const payload = JSON.stringify(shopState, null, 2);
      const tmpPath = `${shopStatePath}.${process.pid}.tmp`;
      await writeFile(tmpPath, payload, "utf8");
      await rename(tmpPath, shopStatePath);
      result = true;
    } catch (error) {
      logger.error({ err: error, shopStatePath }, "FR Family Shop verileri kaydedilemedi");
      result = false;
    }
  }).catch((error) => {
    logger.error({ err: error, shopStatePath }, "FR Family Shop kayıt kuyruğu başarısız");
    result = false;
  });

  await shopStateWriteQueue;
  if (result) await saveShopStateToDatabase();
  return result;
}

function shopUserKey(guildId: string, userId: string): string { return `${guildId}:${userId}`; }
function getShopCoins(guildId: string, userId: string): number {
  return Math.max(0, Number(shopState.users[shopUserKey(guildId, userId)]?.coins ?? 0));
}
async function setShopCoins(guildId: string, userId: string, coins: number): Promise<boolean> {
  const key = shopUserKey(guildId, userId);
  const nextCoins = Math.max(0, Math.floor(coins));
  shopState.users[key] = { coins: nextCoins };
  const saved = await saveShopState();
  if (!saved) return false;
  try {
    const raw = await readFile(shopStatePath, "utf8");
    const persisted = JSON.parse(raw) as Partial<ShopState>;
    const persistedCoins = Number(persisted.users?.[key]?.coins ?? NaN);
    if (persistedCoins !== nextCoins) {
      logger.error({ guildId, userId, expected: nextCoins, persisted: persistedCoins }, "Coin bakiyesi diske doğrulanamadı");
      return false;
    }
  } catch (error) {
    logger.error({ err: error, guildId, userId }, "Coin bakiyesi doğrulanamadı");
    return false;
  }
  return true;
}

async function addShopRole(guildId: string, role: JsonRecord, price: number): Promise<void> {
  if (!shopState.shopCatalog[guildId]) shopState.shopCatalog[guildId] = {};
  shopState.shopCatalog[guildId][String(role.id)] = Math.max(1, Math.floor(price));
  await saveShopState();
}

async function removeShopRole(guildId: string, roleId: string): Promise<boolean> {
  const catalog = shopState.shopCatalog[guildId];
  if (!catalog || !catalog[roleId]) return false;
  delete catalog[roleId];
  await saveShopState();
  return true;
}

function shopPriceForRole(role: JsonRecord, guildId = ""): number {
  const catalogPrice = Number(shopState.shopCatalog[guildId]?.[String(role.id ?? "")] ?? 0);
  if (catalogPrice > 0) return catalogPrice;
  try {
    const configured = JSON.parse(process.env.SHOP_ROLE_PRICES_JSON ?? "{}") as Record<string, unknown>;
    const exact = Number(configured[String(role.id)] ?? 0);
    if (exact > 0) return exact;
  } catch { /* varsayılan fiyat kullan */ }
  const byName = SHOP_ROLE_PRICES[normalizedShopRoleName(String(role.name ?? ""))];
  return byName ?? SHOP_ROLE_PRICE_DEFAULT;
}
function shopCampaignActive(guildId: string): boolean {
  const expiresAt = shopState.campaignExpiresAt[guildId] ? Date.parse(shopState.campaignExpiresAt[guildId]) : 0;
  return Boolean(expiresAt && Date.now() < expiresAt);
}

function shopCampaignDiscount(guildId: string): number {
  return shopCampaignActive(guildId) ? Math.max(0, Number(shopState.campaignDiscount[guildId] ?? 0)) : 0;
}

function shopEffectivePrice(guildId: string, basePrice: number): number {
  const discount = shopCampaignDiscount(guildId);
  return discount > 0 ? Math.max(1, Math.floor(basePrice * (100 - discount) / 100)) : basePrice;
}

function randomShopCampaignDiscount(): number {
  return SHOP_CAMPAIGN_DISCOUNTS[Math.floor(Math.random() * SHOP_CAMPAIGN_DISCOUNTS.length)];
}

const SHOP_CAMPAIGN_CHANNEL_ID = "1538967777476616222";

async function findNamedChannel(guildId: string, names: string[]): Promise<JsonRecord | null> {
  try {
    // Kampanya kanalı için verilen sabit ID'yi önce kullan. Böylece kanal adı/Unicode
    // farklılıkları yüzünden #kampanyalar mesajının kaybolması engellenir.
    if (names.some((name) => normalizeChannelName(name) === normalizeChannelName("kampanyalar"))) {
      try {
        const campaignChannel = await discordApi(`/channels/${SHOP_CAMPAIGN_CHANNEL_ID}`);
        if (String(campaignChannel?.guild_id ?? "") === guildId && [0, 5].includes(Number(campaignChannel?.type))) {
          return campaignChannel as JsonRecord;
        }
      } catch (error) {
        logger.warn({ err: error, guildId, channelId: SHOP_CAMPAIGN_CHANNEL_ID }, "Sabit kampanya kanalı alınamadı, isimle arama yapılacak");
      }
    }

    const channels = await discordApi(`/guilds/${guildId}/channels`);
    const wanted = new Set(names.map(normalizeChannelName));
    const list = Array.isArray(channels) ? channels as JsonRecord[] : [];
    return list.find((c) => [0, 5].includes(Number(c.type)) && wanted.has(normalizeChannelName(String(c.name ?? "")))) ?? null;
  } catch (error) {
    logger.warn({ err: error, guildId, names }, "Kanal bulunamadı");
    return null;
  }
}

async function shopRoles(guildId: string): Promise<JsonRecord[]> {
  try {
    const roles = await discordApi(`/guilds/${guildId}/roles`);
    const list = Array.isArray(roles) ? roles as JsonRecord[] : [];
    return list
      .filter((role) => isShopRole(role) || isCatalogShopRole(guildId, role))
      .sort((a, b) => Number(b.position ?? 0) - Number(a.position ?? 0))
      .slice(0, 25);
  } catch (error) {
    logger.warn({ err: error, guildId }, "Mağaza rolleri alınamadı");
    return [];
  }
}

function shopBannerUrl(): string {
  const base = (process.env.PUBLIC_BASE_URL?.trim() || "https://discord-keeper1.onrender.com").replace(/\/$/, "");
  return process.env.SHOP_BANNER_URL?.trim() || `${base}/shop-assets/fr-family-shop.png`;
}

function shopPublicEmbed(coins: number | null = null, guildId = ""): JsonRecord {
  const campaign = Boolean(guildId) && shopCampaignActive(guildId);
  const discount = campaign ? shopCampaignDiscount(guildId) : 0;
  return {
    title: "👑 FR FAMILY SHOP",
    description: [
      "**FR Family Shop'a hoş geldin!**",
      "Mağazadaki ürünleri kategori seçerek inceleyebilir ve satın alma talebi oluşturabilirsin.",
      "",
      coins === null ? "💰 **Coin bakiyesi:** `coin` yazarak kendi bakiyeni görebilirsin." : `💰 **Bakiyen:** **${coins.toLocaleString("tr-TR")} Coin**`,
      "",
      "🛡️ **Güvenli alışveriş:** Rol ve diğer ürünler otomatik teslim edilmez; her sipariş FRArda'ya inceleme için gönderilir.",
      campaign ? `🟢 **KAMPANYA AKTİF:** Mağazada **%${discount} indirim** var.` : "",
    ].join("\n"),
    color: 0x6d4aff,
    image: { url: shopBannerUrl() },
    fields: [
      { name: "👑 Üst Roller", value: "Sunucudaki FR rollerini gör", inline: true },
      { name: "🎨 Özel Rol", value: "Sana özel rol talebi", inline: true },
      { name: "🎁 Diğer Ürünler", value: "Nitro ve yeni ürünler", inline: true },
      { name: "💰 Coin İşlemleri", value: "Coin almak için FRArda", inline: true },
    ],
    footer: { text: "FR FAMILY SHOP • Siparişler manuel onaylanır" },
    timestamp: new Date().toISOString(),
  };
}

function shopRolesEmbed(roles: JsonRecord[], guildId: string, coins: number): JsonRecord {
  const campaign = shopCampaignActive(guildId);
  return {
    title: "👑 FR FAMILY SHOP • ÜST ROLLER",
    description: [
      `💰 **Bakiyen:** ${coins.toLocaleString("tr-TR")} Coin`,
      campaign ? `🏷️ **Kampanya aktif:** seçili ürünlerde %${shopCampaignDiscount(guildId)} indirim` : "",
      "",
      "Aşağıdaki listeden bir rol seç. Satın almadan önce sana **onay ekranı** gösterilecek.",
      "⚠️ Rol **otomatik verilmez**; sipariş yöneticinin onayına gider.",
    ].filter(Boolean).join("\n"),
    color: 0x6d4aff,
    image: { url: shopBannerUrl() },
    fields: roles.slice(0, 25).map((role) => {
      const base = shopPriceForRole(role, guildId);
      const price = shopEffectivePrice(guildId, base);
      return {
        name: `👑 ${String(role.name)}`,
        value: `**${price.toLocaleString("tr-TR")} Coin**${campaign ? `\n~~${base.toLocaleString("tr-TR")}~~ • %${shopCampaignDiscount(guildId)} indirim` : ""}`,
        inline: true,
      };
    }),
    footer: { text: "FR Family Shop • Discord rol sırası korunur" },
    timestamp: new Date().toISOString(),
  };
}

function shopConfirmEmbed(title: string, product: string, price: number, coins: number): JsonRecord {
  return {
    title: "🛒 SATIN ALMA ONAYI",
    description: `**${title}**\n\nBu ürünü satın almak istediğine emin misin?`,
    color: 0x7c5cff,
    image: { url: shopBannerUrl() },
    fields: [
      { name: "📦 Ürün", value: product, inline: true },
      { name: "💰 Fiyat", value: `${price.toLocaleString("tr-TR")} Coin`, inline: true },
      { name: "🪙 Mevcut Bakiye", value: `${coins.toLocaleString("tr-TR")} Coin`, inline: true },
      { name: "📌 Teslimat", value: "Sipariş oluşturulur ve FRArda'ya bildirilir. Bot ürünü otomatik teslim etmez.", inline: false },
    ],
    footer: { text: "FR Family Shop • Satın alma onayı" },
    timestamp: new Date().toISOString(),
  };
}

function shopMenu(): JsonRecord {
  return {
    type: 3,
    custom_id: "shop_menu",
    placeholder: "🛍️ Mağaza kategorisini seç...",
    options: [
      { label: "Üst Roller", value: "roles", description: "Sunucudaki uygun üst rolleri görüntüle", emoji: { name: "👑" } },
      { label: "Özel Rol", value: "special-role", description: "Sana özel rol siparişi oluştur", emoji: { name: "🎨" } },
      { label: "Coin Satın Al", value: "buy-coins", description: "Coin almak için FRArda'ya ulaş", emoji: { name: "💰" } },
      { label: "Diğer Ürünler", value: "other", description: "Nitro ve diğer ürünler", emoji: { name: "🎁" } },
    ],
  };
}

function profileEmbed(user: JsonRecord, title: string, description: string): JsonRecord {
  const id = String(user.id ?? "");
  const username = String(user.global_name ?? user.username ?? "Kullanıcı");
  const avatarHash = String(user.avatar ?? "");
  const avatar = id && avatarHash ? `https://cdn.discordapp.com/avatars/${id}/${avatarHash}.png?size=256` : undefined;
  return {
    title,
    description,
    thumbnail: avatar ? { url: avatar } : undefined,
    fields: [
      { name: "👤 Kullanıcı", value: `${username}\n<@${id}>`, inline: true },
      { name: "🆔 Kullanıcı ID", value: `\`${id}\``, inline: true },
    ],
    color: 0x5865f2,
    timestamp: new Date().toISOString(),
  };
}

async function sendShopOrderToOwner(guildId: string, order: ShopOrder, user: JsonRecord): Promise<void> {
  const ownerId = process.env.FRARDA_OWNER_ID?.trim() || FRARDA_CONTACT_ID;
  try {
    const dm = await createDirectMessage(ownerId);
    await sendMessage(dm, {
      content: `<@${ownerId}>`,
      embeds: [profileEmbed(user, "🛒 Yeni FR Family Shop Siparişi", [
        `**Ürün:** ${order.product}`,
        `**Tutar:** ${order.price.toLocaleString("tr-TR")} coin`,
        `**Durum:** 🟡 İşlem devam ediyor`,
        `**Sipariş ID:** \`${order.id}\``,
        `**Sunucu:** \`${guildId}\``,
        "",
        "⚠️ Bu siparişte rol/ürün bot tarafından otomatik verilmez. Yönetici işlemi tamamlamalıdır.",
        "👇 İşlemi bitirdiğinde aşağıdaki butona bas.",
      ].join("\n"))],
      components: [row(
        button(`shop_finish:${guildId}:${order.id}`, "✅ Sipariş Tamamlandı", 3),
        button(`shop_reject:${guildId}:${order.id}`, "❌ Siparişi Reddet", 4),
      )],
      allowed_mentions: { users: [ownerId] },
    });
  } catch (error) {
    logger.warn({ err: error, orderId: order.id }, "Shop siparişi yönetici DM'ine gönderilemedi");
  }
}

async function postShopOrder(guildId: string, order: ShopOrder, user: JsonRecord): Promise<void> {
  const channel = await findNamedChannel(guildId, ["sipariş-aktivasyonu", "siparis-aktivasyonu"]);
  if (!channel?.id) return;
  await sendMessage(String(channel.id), {
    embeds: [profileEmbed(user, "🟡 Sipariş İşleme Alındı", [
      `**Sipariş:** ${order.product}`,
      `**Tutar:** ${order.price.toLocaleString("tr-TR")} coin`,
      `**Durum:** 🟡 İşlem devam ediyor`,
      `**Sipariş ID:** \`${order.id}\``,
      "",
      "Yönetici işlemi tamamladığında bu sipariş için ayrıca tamamlandı bildirimi gönderilir.",
    ].join("\n"))],
    allowed_mentions: { parse: [] },
  });
}

async function finishShopOrder(guildId: string, orderId: string): Promise<boolean> {
  const order = shopState.orders.find((item) => item.id === orderId && item.guildId === guildId);
  if (!order || order.status !== "devam-ediyor") return false;
  order.status = "tamamlandi";
  await saveShopState();
  const channel = await findNamedChannel(guildId, ["sipariş-aktivasyonu", "siparis-aktivasyonu"]);
  if (!channel?.id) return true;
  await sendMessage(String(channel.id), {
    embeds: [{
      title: "✅ Sipariş Tamamlandı",
      description: `**Sipariş başarıyla tamamlandı.**\n\n**Sipariş ID:** \`${order.id}\`\n**Ürün:** ${order.product}\n**Tutar:** ${order.price.toLocaleString("tr-TR")} coin\n**Müşteri:** <@${order.userId}>`,
      color: 0x22c55e,
      timestamp: new Date().toISOString(),
      footer: { text: "FR Family Shop • Sipariş Aktivasyonu" },
    }],
    allowed_mentions: { users: [order.userId] },
  });
  try {
    const dm = await createDirectMessage(order.userId);
    await sendMessage(dm, {
      embeds: [{
        title: "✅ Siparişin Tamamlandı",
        description: `Siparişin yönetici tarafından tamamlandı.\n\n**Ürün:** ${order.product}\n**Ödenen:** ${order.price.toLocaleString("tr-TR")} coin\n**Sipariş ID:** \`${order.id}\``,
        color: 0x22c55e,
        footer: { text: "FR Family Shop" },
      }],
    });
  } catch (error) {
    logger.warn({ err: error, orderId: order.id }, "Sipariş tamamlandı DM'i gönderilemedi");
  }
  return true;
}

async function rejectShopOrder(guildId: string, orderId: string): Promise<boolean> {
  const order = shopState.orders.find((item) => item.id === orderId && item.guildId === guildId);
  if (!order || order.status !== "devam-ediyor") return false;
  order.status = "iptal";
  const currentCoins = getShopCoins(guildId, order.userId);
  await setShopCoins(guildId, order.userId, currentCoins + order.price);
  await saveShopState();

  const channel = await findNamedChannel(guildId, ["sipariş-aktivasyonu", "siparis-aktivasyonu"]);
  if (channel?.id) {
    await sendMessage(String(channel.id), {
      embeds: [{
        title: "❌ Sipariş Reddedildi • Ücret İade Edildi",
        description: `**Sipariş reddedildi ve ödenen coinler kullanıcıya iade edildi.**\n\n**Sipariş ID:** \`${order.id}\`\n**Ürün:** ${order.product}\n**İade:** ${order.price.toLocaleString("tr-TR")} coin\n**Müşteri:** <@${order.userId}>\n**Durum:** 🔴 Reddedildi / İade edildi`,
        color: 0xef4444,
        timestamp: new Date().toISOString(),
        footer: { text: "FR Family Shop • Sipariş Aktivasyonu" },
      }],
      allowed_mentions: { users: [order.userId] },
    });
  }
  try {
    const dm = await createDirectMessage(order.userId);
    await sendMessage(dm, {
      embeds: [{
        title: "❌ Siparişin Reddedildi",
        description: `Siparişin yönetici tarafından reddedildi ve ödediğin coinler hesabına iade edildi.\n\n**Ürün:** ${order.product}\n**İade:** ${order.price.toLocaleString("tr-TR")} coin\n**Sipariş ID:** \`${order.id}\``,
        color: 0xef4444,
        footer: { text: "FR Family Shop" },
      }],
    });
  } catch (error) {
    logger.warn({ err: error, orderId: order.id }, "Sipariş reddedildi DM'i gönderilemedi");
  }
  return true;
}

async function createShopOrder(guildId: string, user: JsonRecord, product: string, price: number): Promise<ShopOrder | null> {
  await loadShopState();
  const userId = String(user.id ?? "");
  const coins = getShopCoins(guildId, userId);
  if (coins < price) return null;
  const savedCoins = await setShopCoins(guildId, userId, coins - price);
  if (!savedCoins) return null;
  const order: ShopOrder = {
    id: `FR-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`,
    guildId,
    userId,
    username: String(user.username ?? "Kullanıcı"),
    displayName: String(user.global_name ?? user.username ?? "Kullanıcı"),
    product,
    price,
    status: "devam-ediyor",
    createdAt: new Date().toISOString(),
  };
  shopState.orders.push(order);
  await saveShopState();
  await Promise.all([sendShopOrderToOwner(guildId, order, user), postShopOrder(guildId, order, user)]);
  return order;
}


function shopOpenButton(): JsonRecord {
  if (FR_SHOP_ACTIVITY_URL) {
    return { type: 2, style: 5, label: "🛍️ Mağaza Aç", url: FR_SHOP_ACTIVITY_URL };
  }
  return shopOpenButton();
}

async function handleShopSlash(interaction: JsonRecord, guildId: string): Promise<void> {
  await loadShopState();
  const channel = await findNamedChannel(guildId, ["mağaza", "magaza", "shop"]);
  if (!channel?.id) {
    await interactionReply(interaction, "❌ `#mağaza` kanalı bulunamadı.", [], true);
    return;
  }

  const sent = await sendMessage(String(channel.id), {
    embeds: [shopPublicEmbed(null, guildId)],
    components: [row(shopOpenButton())],
    allowed_mentions: { parse: [] },
  });
  const ids = shopState.shopMessageIds[guildId] ?? [];
  shopState.shopMessageIds[guildId] = [...ids.filter((id) => id !== String(sent?.id ?? "")), String(sent?.id ?? "")].filter(Boolean).slice(-20);
  await saveShopState();
  await interactionReply(interaction, "✅ FR Family Shop giriş mesajı #mağaza kanalına gönderildi.", [], true);
}

async function trackShopSession(interaction: JsonRecord, guildId: string): Promise<void> {
  const userId = String((interaction.member?.user ?? interaction.user ?? {}).id ?? "");
  const token = String(interaction.token ?? "");
  if (!userId || !token || !guildId) return;
  activeShopSessions.set(`${guildId}:${userId}`, {
    guildId,
    applicationId: String(interaction.application_id ?? frArdaBotId),
    token,
    updatedAt: Date.now(),
  });
}

async function refreshActiveShopSessions(guildId: string): Promise<void> {
  const now = Date.now();
  for (const [key, session] of activeShopSessions) {
    if (session.guildId !== guildId) continue;
    // Discord interaction tokenleri yaklaşık 15 dakika geçerlidir.
    if (now - session.updatedAt > 14 * 60_000) {
      activeShopSessions.delete(key);
      continue;
    }
    try {
      await discordApi(`/webhooks/${session.applicationId}/${session.token}/messages/@original`, {
        method: "PATCH",
        body: JSON.stringify({
          content: "",
          embeds: [shopPublicEmbed(null, guildId)],
          components: [row(shopMenu())],
        }),
      });
    } catch (error) {
      activeShopSessions.delete(key);
      logger.debug({ err: error, guildId, key }, "Aktif shop GUI yenilenemedi; oturum temizlendi");
    }
  }
}

async function refreshActiveShopSessionForUser(guildId: string, userId: string): Promise<void> {
  const key = `${guildId}:${userId}`;
  const session = activeShopSessions.get(key);
  if (!session) return;
  if (Date.now() - session.updatedAt > 14 * 60_000) {
    activeShopSessions.delete(key);
    return;
  }
  try {
    await loadShopState();
    const coins = getShopCoins(guildId, userId);
    await discordApi(`/webhooks/${session.applicationId}/${session.token}/messages/@original`, {
      method: "PATCH",
      body: JSON.stringify({
        content: "",
        embeds: [shopPublicEmbed(coins, guildId)],
        components: [row(shopMenu())],
      }),
    });
  } catch (error) {
    activeShopSessions.delete(key);
    logger.debug({ err: error, guildId, userId }, "Kullanıcının açık shop GUI'si yenilenemedi");
  }
}

async function refreshPublicShopMessages(guildId: string): Promise<void> {
  await loadShopState();
  const channel = await findNamedChannel(guildId, ["mağaza", "magaza", "shop"]);
  if (!channel?.id) return;
  const channelId = String(channel.id);
  const body = {
    embeds: [shopPublicEmbed(null, guildId)],
    components: [row(shopOpenButton())],
    allowed_mentions: { parse: [] },
  } as JsonRecord;

  const tracked = new Set(shopState.shopMessageIds[guildId] ?? []);
  try {
    const messages = await discordApi(`/channels/${channelId}/messages?limit=100`);
    if (Array.isArray(messages)) {
      for (const message of messages as JsonRecord[]) {
        const id = String(message.id ?? "");
        const hasShopButton = JSON.stringify(message.components ?? []).includes('"shop_open"');
        const hasShopEmbed = JSON.stringify(message.embeds ?? []).includes("FR FAMILY SHOP");
        if (id && (tracked.has(id) || hasShopButton || hasShopEmbed)) {
          try { await editMessage(channelId, id, body); tracked.add(id); } catch (error) { logger.warn({ err: error, guildId, messageId: id }, "Shop mesajı yenilenemedi"); }
        }
      }
    }
  } catch (error) {
    logger.warn({ err: error, guildId, channelId }, "Shop mesajları taranamadı");
  }
  shopState.shopMessageIds[guildId] = [...tracked].slice(-20);
  await saveShopState();
}

async function handleCoinMessage(message: JsonRecord): Promise<boolean> {
  if (String(message.content ?? "").trim().toLocaleLowerCase("tr-TR") !== "coin") return false;
  const guildId = String(message.guild_id ?? "");
  const userId = String(message.author?.id ?? "");
  if (!guildId || !userId) return false;
  await loadShopState();
  const coins = getShopCoins(guildId, userId);
  const reply = await sendMessage(String(message.channel_id), {
    content: `💰 ${String(message.author?.global_name ?? message.author?.username ?? "Kullanıcı")}, bakiyen: **${coins.toLocaleString("tr-TR")} coin**`,
    allowed_mentions: { parse: [] },
  });
  setTimeout(() => {
    void Promise.all([
      deleteMessage(String(message.channel_id), String(message.id)).catch(() => undefined),
      deleteMessage(String(message.channel_id), String(reply?.id ?? "")).catch(() => undefined),
    ]);
  }, 10_000);
  return true;
}

function campaignEmbed(guildId: string, type: "start" | "end"): JsonRecord {
  if (type === "end") {
    return {
      title: "🛍️ FR FAMILY SHOP • KAMPANYA SONA ERDİ",
      description: "Kampanya sona erdi. Mağaza fiyatları normal fiyatlara döndü.",
      color: 0x5865f2,
      fields: [
        { name: "🏷️ Durum", value: "**Kampanya sona erdi**", inline: true },
        { name: "💰 Fiyatlar", value: "**Normal fiyatlar aktif**", inline: true },
      ],
      image: process.env.SHOP_CAMPAIGN_IMAGE_URL ? { url: process.env.SHOP_CAMPAIGN_IMAGE_URL } : undefined,
      footer: { text: "FR Family Shop • Kampanya bitti" },
      timestamp: new Date().toISOString(),
    };
  }
  const discount = shopCampaignDiscount(guildId);
  const expiresAt = shopState.campaignExpiresAt[guildId];
  return {
    title: "FR FAMILY SHOP • KAMPANYA",
    description: `Mağazada **%${discount} indirim başladı!**\nKampanya **2 gün boyunca geçerlidir.** 🛍️`,
    color: 0x22c55e,
    fields: [
      { name: "İndirim", value: `**%${discount}**`, inline: true },
      { name: "Süre", value: "**2 gün**", inline: true },
    ],
    image: process.env.SHOP_CAMPAIGN_IMAGE_URL ? { url: process.env.SHOP_CAMPAIGN_IMAGE_URL } : undefined,
    footer: { text: "FR Family Shop • Kampanya otomatik fiyat güncellemesi" },
    timestamp: expiresAt ? new Date(expiresAt).toISOString() : new Date().toISOString(),
  };
}

async function sendCampaignMessage(guildId: string, type: "start" | "end"): Promise<boolean> {
  // Önce kullanıcının verdiği kesin kanal ID'sini doğrudan dene.
  const channelId = SHOP_CAMPAIGN_CHANNEL_ID;
  try {
    const channel = await discordApi(`/channels/${channelId}`) as JsonRecord;
    if (String(channel?.guild_id ?? "") === guildId && (Number(channel?.type) === 0 || Number(channel?.type) === 5)) {
      await sendMessage(channelId, { embeds: [campaignEmbed(guildId, type)], allowed_mentions: { parse: [] } });
      return true;
    }
  } catch (error) {
    logger.warn({ err: error, guildId, channelId, type }, "Sabit kampanya kanalına mesaj gönderilemedi");
  }

  // ID ile erişim olmazsa isim üzerinden son bir deneme yap.
  try {
    const channel = await findNamedChannel(guildId, ["kampanyalar", "kampanya"]);
    if (channel?.id) {
      await sendMessage(String(channel.id), { embeds: [campaignEmbed(guildId, type)], allowed_mentions: { parse: [] } });
      return true;
    }
  } catch (error) {
    logger.error({ err: error, guildId, type }, "Kampanya mesajı hiçbir kanala gönderilemedi");
  }
  return false;
}

async function endShopCampaign(guildId: string, notify = true): Promise<boolean> {
  await loadShopState();
  if (!shopCampaignActive(guildId)) {
    delete shopState.campaignDiscount[guildId];
    delete shopState.campaignExpiresAt[guildId];
    await saveShopState();
    return false;
  }

  delete shopState.campaignDiscount[guildId];
  delete shopState.campaignExpiresAt[guildId];
  await saveShopState();

  const timer = shopTimers.get(`campaign:${guildId}`);
  if (timer) {
    clearTimeout(timer);
    shopTimers.delete(`campaign:${guildId}`);
  }
  await refreshPublicShopMessages(guildId);
  await refreshActiveShopSessions(guildId);
  if (notify) await sendCampaignMessage(guildId, "end");
  return true;
}

async function startShopCampaign(guildId: string, notify = true): Promise<{ ok: boolean; discount?: number; messageSent?: boolean }> {
  await loadShopState();
  if (shopCampaignActive(guildId)) return { ok: false, discount: shopCampaignDiscount(guildId) };

  const discount = randomShopCampaignDiscount();
  const now = Date.now();
  shopState.lastCampaignAt[guildId] = new Date(now).toISOString();
  shopState.campaignDiscount[guildId] = discount;
  shopState.campaignExpiresAt[guildId] = new Date(now + SHOP_CAMPAIGN_DURATION_MS).toISOString();
  await saveShopState();

  const oldTimer = shopTimers.get(`campaign:${guildId}`);
  if (oldTimer) clearTimeout(oldTimer);
  const timer = setTimeout(() => {
    void endShopCampaign(guildId, true);
  }, SHOP_CAMPAIGN_DURATION_MS);
  shopTimers.set(`campaign:${guildId}`, timer);

  await refreshPublicShopMessages(guildId);
  await refreshActiveShopSessions(guildId);
  const messageSent = notify ? await sendCampaignMessage(guildId, "start") : true;
  return { ok: true, discount, messageSent };
}

async function runCampaignForGuild(guildId: string): Promise<void> {
  await loadShopState();
  if (shopCampaignActive(guildId)) return;

  const last = shopState.lastCampaignAt[guildId] ? Date.parse(shopState.lastCampaignAt[guildId]) : 0;
  if (last && Date.now() - last < SHOP_CAMPAIGN_INTERVAL_MS) return;

  // Otomatik kontrol sadece kampanyayı başlatır; kanal spamı yapmaz.
  // Manuel /kampanya komutu kampanya duyurusunu gönderir.
  await startShopCampaign(guildId, false);
}

async function restoreShopCampaignTimers(guildIds: string[]): Promise<void> {
  await loadShopState();
  for (const guildId of guildIds) {
    const expiresAt = shopState.campaignExpiresAt[guildId] ? Date.parse(shopState.campaignExpiresAt[guildId]) : 0;
    if (!expiresAt) continue;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      void endShopCampaign(guildId, true);
      continue;
    }
    const timer = setTimeout(() => {
      void endShopCampaign(guildId, true);
    }, remaining);
    shopTimers.set(`campaign:${guildId}`, timer);
  }
}

async function startShopCampaignLoop(guildIds: string[]): Promise<void> {
  await restoreShopCampaignTimers(guildIds);
  for (const guildId of guildIds) void runCampaignForGuild(guildId);
  if (shopTimers.has("global")) return;
  const timer = setInterval(() => {
    for (const guildId of guildIds) void runCampaignForGuild(guildId);
  }, 60 * 60 * 1000);
  shopTimers.set("global", timer);
}


function jsonHeaders(): Record<string, string> {
  return {
    Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN ?? ""}`,
    "Content-Type": "application/json",
    "User-Agent": "FrArda/1.0",
  };
}

async function discordApi(
  path: string,
  init: RequestInit = {},
): Promise<JsonRecord | JsonRecord[] | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${DISCORD_API}${path}`, {
      ...init,
      headers: { ...jsonHeaders(), ...(init.headers ?? {}) },
    });
    if (response.status === 204) return null;
    const body = await response.text();
    if (response.ok) {
      return body ? (JSON.parse(body) as JsonRecord | JsonRecord[]) : null;
    }
    if (response.status === 429 && attempt < 2) {
      let retryAfterMs = 1_000;
      try {
        const rateLimit = JSON.parse(body) as JsonRecord;
        retryAfterMs = Math.ceil(Number(rateLimit.retry_after ?? 1) * 1_000) + 100;
      } catch {
        // Use the safe default when Discord returns a non-JSON rate-limit body.
      }
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
      continue;
    }
    throw new Error(`Discord API ${response.status}: ${body.slice(0, 300)}`);
  }
  throw new Error(`Discord API ${path} rate limit retry limit reached`);
}

async function createDirectMessage(userId: string): Promise<string> {
  const channel = (await discordApi("/users/@me/channels", {
    method: "POST",
    body: JSON.stringify({ recipient_id: userId }),
  })) as JsonRecord;
  return String(channel.id);
}

async function sendMessage(
  channelId: string,
  body: JsonRecord,
): Promise<JsonRecord> {
  return (await discordApi(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify(body),
  })) as JsonRecord;
}

async function deleteMessage(channelId: string, messageId: string): Promise<void> {
  await discordApi(`/channels/${channelId}/messages/${messageId}`, {
    method: "DELETE",
  });
}

async function editMessage(
  channelId: string,
  messageId: string,
  body: JsonRecord,
): Promise<void> {
  await discordApi(`/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

async function timeoutMember(
  guildId: string,
  userId: string,
  timeoutUntil: string | null,
  reason: string,
): Promise<void> {
  await discordApi(`/guilds/${guildId}/members/${userId}`, {
    method: "PATCH",
    headers: { "X-Audit-Log-Reason": encodeURIComponent(reason) },
    body: JSON.stringify({ communication_disabled_until: timeoutUntil }),
  });
}

async function addHeartReaction(channelId: string, messageId: string): Promise<void> {
  await discordApi(
    `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent("❤️")}/@me`,
    { method: "PUT" },
  );
}

function button(
  customId: string,
  label: string,
  style = 2,
  disabled = false,
): JsonRecord {
  return { type: 2, style, label, custom_id: customId, disabled };
}

function row(...components: JsonRecord[]): JsonRecord {
  return { type: 1, components };
}

function hasModeratorPermission(interaction: JsonRecord): boolean {
  const permissions = BigInt(String(interaction.member?.permissions ?? "0"));
  return (permissions & (ADMINISTRATOR | MANAGE_GUILD)) !== 0n;
}

function durationFor(category: ModerationCase["category"]): number {
  if (category === "argo") return 60_000;
  if (category === "link") return 5 * 60_000;
  if (category === "kavga") return 30 * 60_000;
  if (category === "cinsel" || category === "gorsel") return 60 * 60_000;
  return 60 * 60_000;
}

function durationLabel(milliseconds: number): string {
  if (milliseconds < 60_000) return "1 dakika";
  if (milliseconds < 60 * 60_000) return `${Math.round(milliseconds / 60_000)} dakika`;
  return `${Math.round(milliseconds / (60 * 60_000))} saat`;
}

function normalizeForModeration(text: string): string {
  return text
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ç/g, "c")
    .replace(/ğ/g, "g")
    .replace(/ı/g, "i")
    .replace(/ö/g, "o")
    .replace(/ş/g, "s")
    .replace(/ü/g, "u")
    .replace(/[4@]/g, "a").replace(/[1!|]/g, "i").replace(/[3]/g, "e")
    .replace(/[5$]/g, "s").replace(/[0]/g, "o").replace(/[7]/g, "t")
    .replace(/[^a-z0-9\s]/gi, " ").replace(/\s+/g, " ").trim();
}

function hasObfuscatedWord(text: string, words: string[]): boolean {
  const compact = normalizeForModeration(text).replace(/\s+/g, "");
  return words.some((word) => compact.includes(normalizeForModeration(word).replace(/\s+/g, "")));
}

function hasWholeWord(normalized: string, word: string): boolean {
  const escaped = normalizeForModeration(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, "i").test(normalized);
}

function hasPhrase(normalized: string, phrase: string): boolean {
  const compactPhrase = normalizeForModeration(phrase).replace(/\s+/g, " ").trim();
  if (!compactPhrase) return false;
  return normalized.includes(compactPhrase);
}

function fallbackClassification(text: string): {
  category: ClassificationCategory;
  reason: string;
} {
  const normalized = normalizeForModeration(text);
  const profanity = [
    "amk", "aq", "amina koyayim", "aminakoyim", "siktir", "sikerim", "siktim",
    "orospu", "pic", "yarrak", "ibne", "gerizekali", "gavat", "serefsiz",
  ];
  const slang = ["salak", "aptal", "mal", "ulan", "ezik", "gerzek", "dangalak"];
  const fightWords = ["kavga", "saldir", "tehdit", "dayak"];
  const fightPhrases = ["dovecem", "dovucem", "oldurecegim", "vuracagim", "seni oldur", "sana zarar"];
  const sexualWords = [
    "sikis", "sikise", "sikismek", "sikisiyor", "porno", "pornografik",
    "pornograf", "nsfw", "nude", "ciplaklik", "cinsel organ",
  ];

  // Önce yüksek güvenli, kelime sınırlarına dayalı eşleşmeler yapıyoruz.
  // Böylece örneğin “sıkıntı”, “normal” gibi masum kelimeler yanlışlıkla ihlal sayılmaz.
  if (fightWords.some((word) => hasWholeWord(normalized, word)) || fightPhrases.some((phrase) => hasPhrase(normalized, phrase))) {
    return { category: "kavga", reason: "Kavga veya tehdit ifadesi algılandı." };
  }
  if (profanity.some((word) => hasWholeWord(normalized, word)) || hasObfuscatedWord(text, profanity)) {
    return { category: "kufur", reason: "Küfür veya ağır hakaret algılandı." };
  }
  if (sexualWords.some((word) => hasWholeWord(normalized, word)) || sexualWords.some((phrase) => hasPhrase(normalized, phrase))) {
    return { category: "cinsel", reason: "18+ veya cinsel içerikli ifade algılandı." };
  }
  if (slang.some((word) => hasWholeWord(normalized, word))) {
    return { category: "argo", reason: "Argo veya hakaret algılandı." };
  }
  return { category: "clean", reason: "" };
}

function extractJsonObject(raw: string): JsonRecord | null {
  const cleaned = raw.replace(/```json|```/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as JsonRecord;
  } catch {
    return null;
  }
}

function uniqueModels(...models: Array<string | undefined>): string[] {
  return [...new Set(models.map((model) => String(model ?? "").trim()).filter(Boolean))];
}

async function classifyWithGroq(
  content: string,
  imageUrl?: string,
): Promise<{ category: ClassificationCategory | "gorsel"; reason: string }> {
  const fallback = fallbackClassification(content);
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    // Görsel güvenlik servisi yoksa yanlış pozitif üretmemek için görseli silme.
    // Metin moderasyonu yine yerel fallback ile çalışır.
    logger.warn({ image: Boolean(imageUrl) }, "GROQ_API_KEY yok; görsel moderasyonu atlandı");
    return fallback;
  }

  const messageContent: JsonRecord[] = [
    {
      type: "text",
      text: [
        "Sen FrArda Discord moderasyon yardımcısısın.",
        "Mesajı Türkçe bağlamıyla değerlendir.",
        'Sadece şu JSON formatında cevap ver: {"category":"clean|argo|kufur|kavga|cinsel","reason":"kısa Türkçe açıklama","matched":"mesajdaki gerçek kelime veya görseldeki kısa açıklama","confidence":0.0}',
        "clean: kural ihlali yok.",
        "argo: hafif argo/hakaret.",
        "kufur: açık küfür/ağır hakaret.",
        "kavga: tehdit, şiddet çağrısı veya kavga kışkırtması.",
        "cinsel: çıplaklık, cinsel organ, cinsel eylem, pornografik veya açıkça 18+ içerik.",
        "ÇOK ÖNEMLİ: Mesajda açıkça bulunmayan bir hakareti varsayma. Şüphede clean seç.",
        "Görsel varsa yalnızca açık ve tartışmasız çıplaklık, cinsel organ veya cinsel eylem görüyorsan cinsel olarak işaretle. Normal insan fotoğrafları, mayo/plaj fotoğrafları, sanat, çizim, meme, oyun ekran görüntüsü, romantik içerik veya belirsiz görüntüler clean olmalı. Şüphede clean seç.",
        "matched alanına mesajdaki gerçek kelimeyi veya görseldeki açık ihlalin kısa açıklamasını yaz. clean ise boş bırak.",
        `Mesaj: ${content || "(görsel gönderildi)"}`,
      ].join("\n"),
    },
  ];
  if (imageUrl) {
    messageContent.push({ type: "image_url", image_url: { url: imageUrl } });
  }

  const models = uniqueModels(
    process.env.GROQ_MODEL,
    process.env.GROQ_CHAT_MODEL,
    "llama-3.3-70b-versatile",
  );
  let lastError = "Groq modeli yanıt vermedi.";
  for (const model of models) {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 220,
          messages: [{ role: "user", content: messageContent }],
        }),
      });
      const responseText = await response.text();
      if (!response.ok) {
        lastError = `Groq API ${response.status}`;
        logger.warn({ status: response.status, model }, "Groq moderasyon modeli başarısız; diğer model deneniyor");
        continue;
      }
      const body = JSON.parse(responseText) as JsonRecord;
      const raw = String(body.choices?.[0]?.message?.content ?? "");
      const parsed = extractJsonObject(raw);
      if (!parsed) {
        lastError = "Groq JSON yanıtı çözümlenemedi";
        logger.warn({ model }, "Groq moderasyon yanıtı JSON değil; diğer model deneniyor");
        continue;
      }
      const category = ["clean", "argo", "kufur", "kavga", "cinsel"].includes(String(parsed.category))
        ? (String(parsed.category) as ClassificationCategory)
        : "clean";
      const matched = normalizeForModeration(String(parsed.matched ?? ""));
      const normalizedContent = normalizeForModeration(content);
      const confidence = Math.max(0, Math.min(1, Number(parsed.confidence ?? 0)));

      // Metin ihlalini, modelin gerçekten mesajdaki ifadeyi bulduğunu doğrulayarak uygula.
      // Görsel ihlalinde ise matched görseli tarif eder; metin içinde aranmaz.
      if (category === "cinsel" && imageUrl) {
        // Görselde yalnızca yüksek güvenli, açık cinsel içerikleri engelle.
        if (confidence >= 0.85) {
          return { category, reason: String(parsed.reason ?? "18+ veya cinsel içerikli görsel algılandı.") };
        }
        return { category: "clean", reason: "Görsel cinsel içerik açısından yeterince net değil; engellenmedi." };
      }
      if (category !== "clean" && matched && normalizedContent.includes(matched)) {
        return { category, reason: String(parsed.reason ?? fallback.reason) };
      }
      if (fallback.category !== "clean") return fallback;
      return { category: "clean", reason: "" };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Groq değerlendirmesi başarısız";
      logger.warn({ err: error, model }, "Groq değerlendirmesi başarısız; diğer model deneniyor");
    }
  }
  logger.warn({ lastError, image: Boolean(imageUrl) }, "Groq moderasyon modelleri tükendi");
  // Servis/model hatası gerçek bir ihlal değildir. Yanlış pozitifleri önlemek için
  // görseli otomatik olarak engellemek yerine temiz kabul ediyoruz.
  return fallback;
}

async function findFrArdaOwner(guildId: string): Promise<string | null> {
  if (process.env.FRARDA_OWNER_ID) return process.env.FRARDA_OWNER_ID;
  try {
    const guild = (await discordApi(`/guilds/${guildId}`)) as JsonRecord;
    return guild.owner_id ? String(guild.owner_id) : null;
  } catch (error) {
    logger.warn({ err: error, guildId }, "Sunucu sahibi bulunamadı");
    return null;
  }
}

async function persistModerationCase(caseData: ModerationCase): Promise<void> {
  // PostgreSQL kaldırıldı; vakalar çalışma süresince bellekte tutulur.
  moderationCases.set(caseData.id, caseData);
}

function moderationCategoryLabel(category: ModerationCase["category"]): string {
  return ({
    link: "İzinsiz link",
    argo: "Argo / hakaret",
    kufur: "Küfür / ağır hakaret",
    kavga: "Tehdit / kavga",
    cinsel: "18+ / cinsel içerik",
    gorsel: "Güvenlik kontrolü yapılamayan görsel",
  } as Record<ModerationCase["category"], string>)[category];
}

function moderationColor(category: ModerationCase["category"]): number {
  return ({
    link: 0xf97316,
    argo: 0xeab308,
    kufur: 0xef4444,
    kavga: 0xdc2626,
    cinsel: 0xdb2777,
    gorsel: 0x7c3aed,
  } as Record<ModerationCase["category"], number>)[category];
}

async function notifyFrArdaOwner(caseData: ModerationCase): Promise<void> {
  const ownerId = await findFrArdaOwner(caseData.guildId);
  if (!ownerId) return;
  caseData.frArdaUserId = ownerId;
  const channelId = await createDirectMessage(ownerId);
  let username = "Bilinmiyor";
  let displayName = "Bilinmiyor";
  let avatar: string | undefined;
  try {
    const user = (await discordApi(`/users/${caseData.userId}`)) as JsonRecord;
    username = String(user.username ?? "Bilinmiyor");
    displayName = String(user.global_name ?? username);
    avatar = userAvatarUrl(caseData.userId, user.avatar, 256);
  } catch (error) {
    logger.debug?.({ err: error, userId: caseData.userId }, "İtiraz bildirimi için kullanıcı bilgisi alınamadı");
  }
  await sendMessage(channelId, {
    content: "Yeni bir moderasyon itirazı inceleme bekliyor.",
    allowed_mentions: { parse: [] },
    embeds: [{
      title: "⚖️ FrArda • İtiraz İncelemesi",
      description: "Bir üye uygulanan moderasyon işlemine itiraz etti. Karar vermeden önce aşağıdaki bilgileri incele.",
      color: moderationColor(caseData.category),
      author: {
        name: `${displayName} (@${username})`,
        icon_url: avatar,
      },
      fields: [
        { name: "👤 Kullanıcı", value: `<@${caseData.userId}>\n\`${caseData.userId}\``, inline: true },
        { name: "🏷️ İşlem", value: `${moderationCategoryLabel(caseData.category)}\n${durationLabel(caseData.durationMs)} timeout`, inline: true },
        { name: "🧾 Vaka", value: `\`${caseData.id}\``, inline: true },
        { name: "📌 Tespit edilen sebep", value: truncate(caseData.reason, 1024), inline: false },
        { name: "💬 Üyenin itirazı", value: truncate(caseData.appealReason ?? "Belirtilmedi", 1024), inline: false },
        { name: "⏱️ Timeout bitişi", value: `${formatDate(caseData.timeoutUntil)}\n${formatRelativeDate(caseData.timeoutUntil)}`, inline: false },
      ],
      footer: { text: "5 dakika içinde karar verilmezse üyeye kural sınaması gönderilir." },
      timestamp: new Date().toISOString(),
    }],
    components: [row(
      button(`appeal_accept:${caseData.id}`, "İtirazı kabul et", 3),
      button(`appeal_reject:${caseData.id}`, "İtirazı reddet", 4),
    )],
  });
}

const challengeBank = [
  {
    question: "Bir haftada kaç gün vardır?",
    options: ["5", "7", "9"],
    answer: 1,
  },
  {
    question: "Discord’da mesaj silmek için gereken temel yetki hangisidir?",
    options: ["Mesajları Yönet", "Ses Bağlan", "Takma Ad Yönet"],
    answer: 0,
  },
  {
    question: "2 üzeri 5 kaçtır?",
    options: ["10", "25", "32"],
    answer: 2,
  },
];

async function startChallenge(caseData: ModerationCase): Promise<void> {
  if (!caseData.dmChannelId) return;
  const challenge = challengeBank[Math.floor(Date.now() / 1000) % challengeBank.length];
  caseData.status = "challenge";
  caseData.challengeAnswer = challenge.answer;
  caseData.challengeOptions = challenge.options;
  caseData.challengeQuestion = challenge.question;
  await persistModerationCase(caseData);
  const message = await sendMessage(caseData.dmChannelId, {
    content: "İtiraz inceleme süresi doldu. Son uyarıyı tamamlamak için aşağıdaki kısa sınamayı cevapla.",
    embeds: [
      {
        title: "🧠 Son Uyarı • Kural Sınaması",
        description: `**${challenge.question}**\n\nDoğru cevabı seçtiğinde bu olay için timeout kaldırılır. Yanlış cevap verirsen tekrar deneyebilirsin.`,
        color: 0x38bdf8,
        fields: [
          { name: "🧾 Vaka", value: `\`${caseData.id}\``, inline: true },
          { name: "📌 Durum", value: "Son uyarı bekleniyor", inline: true },
        ],
        footer: { text: "Bu sınama yalnızca ilgili kullanıcı tarafından cevaplanabilir." },
      },
    ],
    components: [
      row(...challenge.options.map((option, index) => button(
        `challenge:${caseData.id}:${index}`,
        `Cevap: ${option}`,
      ))),
    ],
  });
  caseData.challengeMessageId = String(message.id);
}

async function handleViolation(
  message: JsonRecord,
  category: ModerationCase["category"],
  reason: string,
): Promise<void> {
  const userId = String(message.author.id);
  const guildId = String(message.guild_id);
  const durationMs = durationFor(category);
  const timeoutUntil = new Date(Date.now() + durationMs).toISOString();
  const caseData: ModerationCase = {
    id: `${guildId}-${userId}-${Date.now()}`,
    guildId,
    channelId: String(message.channel_id),
    userId,
    username: String(message.author?.username ?? "Bilinmiyor"),
    displayName: String(message.author?.global_name ?? message.author?.username ?? "Bilinmiyor"),
    category,
    durationMs,
    reason,
    timeoutUntil,
    status: "pending",
  };
  moderationCases.set(caseData.id, caseData);
  await persistModerationCase(caseData);

  try {
    await deleteMessage(caseData.channelId, String(message.id));
  } catch (error) {
    logger.warn({ err: error, guildId }, "İhlal mesajı silinemedi");
  }
  try {
    await timeoutMember(guildId, userId, timeoutUntil, `FrArda: ${reason}`);
  } catch (error) {
    logger.error({ err: error, guildId, userId }, "Üye susturulamadı");
  }

  try {
    caseData.dmChannelId = await createDirectMessage(userId);
    await sendMessage(caseData.dmChannelId, {
      content: "FrArda moderasyon bildirimi",
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: "🚨 FrArda • Moderasyon İşlemi",
          description: "Mesajın sunucu kurallarına aykırı olduğu için kaldırıldı ve hesabına geçici timeout uygulandı.",
          color: moderationColor(category),
          fields: [
            { name: "🏷️ İşlem", value: `${moderationCategoryLabel(category)}\n${durationLabel(durationMs)} timeout`, inline: true },
            { name: "⏱️ Bitiş zamanı", value: `${formatDate(timeoutUntil)}\n${formatRelativeDate(timeoutUntil)}`, inline: true },
            { name: "📌 Sebep", value: truncate(reason, 1024), inline: false },
            { name: "🧾 Vaka numarası", value: `\`${caseData.id}\``, inline: false },
          ],
          footer: { text: "İtiraz etmek için aşağıdaki düğmeyi kullanabilirsin." },
          timestamp: new Date().toISOString(),
        },
      ],
      components: [row(button(`appeal:${caseData.id}`, "İtiraz gönder", 1))],
    });
  } catch (error) {
    logger.warn({ err: error, userId }, "Moderasyon DM bildirimi gönderilemedi");
  }
  logger.info(
    { guildId, userId, category, durationMs },
    "FrArda moderasyon işlemi uygulandı",
  );
}

async function interactionReply(
  interaction: JsonRecord,
  content: string,
  components: JsonRecord[] = [],
  ephemeral = false,
): Promise<void> {
  await discordApi(
    `/interactions/${interaction.id}/${interaction.token}/callback`,
    {
      method: "POST",
      body: JSON.stringify({
        type: 4,
        data: { content, components, flags: ephemeral ? 64 : 0 },
      }),
    },
  );
}

async function editInteractionOriginal(
  interaction: JsonRecord,
  body: JsonRecord,
): Promise<void> {
  await discordApi(`/webhooks/${interaction.application_id ?? frArdaBotId}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

async function interactionUpdate(
  interaction: JsonRecord,
  content: string,
  components: JsonRecord[] = [],
  embeds: JsonRecord[] = [],
): Promise<void> {
  await discordApi(
    `/interactions/${interaction.id}/${interaction.token}/callback`,
    {
      method: "POST",
      body: JSON.stringify({ type: 7, data: { content, components, embeds } }),
    },
  );
}


const TRANSLATION_LANGUAGES = [
  ["🇹🇷", "Türkiye", "Türkçe", "tr"], ["🇺🇸", "Amerika Birleşik Devletleri", "İngilizce", "en"],
  ["🇩🇪", "Almanya", "Almanca", "de"], ["🇫🇷", "Fransa", "Fransızca", "fr"],
  ["🇪🇸", "İspanya", "İspanyolca", "es"], ["🇮🇹", "İtalya", "İtalyanca", "it"],
  ["🇵🇹", "Portekiz", "Portekizce", "pt"], ["🇧🇷", "Brezilya", "Brezilya Portekizcesi", "pt-BR"],
  ["🇳🇱", "Hollanda", "Felemenkçe", "nl"], ["🇧🇪", "Belçika", "Felemenkçe", "nl"],
  ["🇷🇺", "Rusya", "Rusça", "ru"], ["🇺🇦", "Ukrayna", "Ukraynaca", "uk"],
  ["🇵🇱", "Polonya", "Lehçe", "pl"], ["🇨🇿", "Çekya", "Çekçe", "cs"],
  ["🇸🇰", "Slovakya", "Slovakça", "sk"], ["🇭🇺", "Macaristan", "Macarca", "hu"],
  ["🇷🇴", "Romanya", "Rumence", "ro"], ["🇧🇬", "Bulgaristan", "Bulgarca", "bg"],
  ["🇬🇷", "Yunanistan", "Yunanca", "el"], ["🇷🇸", "Sırbistan", "Sırpça", "sr"],
  ["🇭🇷", "Hırvatistan", "Hırvatça", "hr"], ["🇸🇮", "Slovenya", "Slovence", "sl"],
  ["🇧🇦", "Bosna Hersek", "Boşnakça", "bs"], ["🇲🇰", "Kuzey Makedonya", "Makedonca", "mk"],
  ["🇦🇱", "Arnavutluk", "Arnavutça", "sq"], ["🇧🇾", "Belarus", "Belarusça", "be"],
  ["🇱🇹", "Litvanya", "Litvanca", "lt"], ["🇱🇻", "Letonya", "Letonca", "lv"],
  ["🇪🇪", "Estonya", "Estonca", "et"], ["🇫🇮", "Finlandiya", "Fince", "fi"],
  ["🇸🇪", "İsveç", "İsveççe", "sv"], ["🇳🇴", "Norveç", "Norveççe", "no"],
  ["🇩🇰", "Danimarka", "Danca", "da"], ["🇮🇸", "İzlanda", "İzlandaca", "is"],
  ["🇮🇪", "İrlanda", "İrlandaca", "ga"], ["🇮🇱", "İsrail", "İbranice", "he"],
  ["🇸🇦", "Suudi Arabistan", "Arapça", "ar"], ["🇮🇷", "İran", "Farsça", "fa"],
  ["🇮🇳", "Hindistan", "Hintçe", "hi"], ["🇵🇰", "Pakistan", "Urduca", "ur"],
  ["🇧🇩", "Bangladeş", "Bengalce", "bn"], ["🇮🇩", "Endonezya", "Endonezce", "id"],
  ["🇲🇾", "Malezya", "Malayca", "ms"], ["🇻🇳", "Vietnam", "Vietnamca", "vi"],
  ["🇹🇭", "Tayland", "Tayca", "th"], ["🇨🇳", "Çin", "Çince", "zh"],
  ["🇹🇼", "Tayvan", "Geleneksel Çince", "zh-TW"], ["🇯🇵", "Japonya", "Japonca", "ja"],
  ["🇰🇷", "Güney Kore", "Korece", "ko"], ["🇵🇭", "Filipinler", "Filipince", "tl"],
  ["🇦🇫", "Afganistan", "Peştuca", "ps"], ["🇳🇵", "Nepal", "Nepalce", "ne"],
  ["🇱🇰", "Sri Lanka", "Seylanca", "si"], ["🇰🇪", "Kenya", "Svahili", "sw"],
  ["🇿🇦", "Güney Afrika", "Afrikanca", "af"], ["🇳🇬", "Nijerya", "Yorubaca", "yo"],
  ["🇲🇳", "Moğolistan", "Moğolca", "mn"], ["🇬🇪", "Gürcistan", "Gürcüce", "ka"],
  ["🇦🇲", "Ermenistan", "Ermenice", "hy"], ["🇦🇿", "Azerbaycan", "Azerbaycanca", "az"],
  ["🇰🇿", "Kazakistan", "Kazakça", "kk"], ["🇺🇿", "Özbekistan", "Özbekçe", "uz"],
  ["🇲🇦", "Fas", "Berberice", "ber"], ["🇲🇹", "Malta", "Maltaca", "mt"],
  ["🇱🇺", "Lüksemburg", "Lüksemburgca", "lb"], ["🇻🇦", "Vatikan", "Latince", "la"],
] as const;

function translationLanguageLabel(item: typeof TRANSLATION_LANGUAGES[number]): string {
  return `${item[0]} ${item[1]} — ${item[2]}`;
}

function findTranslationLanguage(value: string): typeof TRANSLATION_LANGUAGES[number] | null {
  const normalized = value.trim().toLocaleLowerCase("tr-TR");
  return TRANSLATION_LANGUAGES.find((item) =>
    item[3].toLocaleLowerCase("tr-TR") === normalized ||
    translationLanguageLabel(item).toLocaleLowerCase("tr-TR") === normalized
  ) ?? null;
}

async function handleTranslationAutocomplete(interaction: JsonRecord): Promise<void> {
  const focused = ((interaction.data?.options ?? []) as JsonRecord[]).find((option) => option.focused);
  const query = String(focused?.value ?? "").toLocaleLowerCase("tr-TR");
  const options = TRANSLATION_LANGUAGES
    .filter((item) => !query || translationLanguageLabel(item).toLocaleLowerCase("tr-TR").includes(query))
    .slice(0, 25)
    .map((item) => ({ name: translationLanguageLabel(item).slice(0, 100), value: item[3] }));
  await discordApi(`/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: "POST",
    body: JSON.stringify({ type: 8, data: { choices: options } }),
  });
}

async function translateWithGroq(text: string, language: typeof TRANSLATION_LANGUAGES[number]): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) return null;
  const model = process.env.GROQ_MODEL?.trim() || "llama-3.3-70b-versatile";
  const target = translationLanguageLabel(language);
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 800,
        messages: [{
          role: "system",
          content: `Sen bir çeviri asistanısın. Metni doğal biçimde ${target} diline çevir. Açıklama, yorum veya ek metin yazma; sadece çeviriyi döndür.`,
        }, { role: "user", content: text.slice(0, 6000) }],
      }),
    });
    if (!response.ok) return null;
    const body = await response.json() as JsonRecord;
    return String(body.choices?.[0]?.message?.content ?? "").trim() || null;
  } catch (error) {
    logger.warn({ err: error, model }, "Çeviri modeli başarısız");
    return null;
  }
}

async function handleTranslationCommand(interaction: JsonRecord): Promise<void> {
  const text = commandOption(interaction, "metin")?.trim() ?? "";
  const targetCode = commandOption(interaction, "dil")?.trim() ?? "";
  const language = findTranslationLanguage(targetCode);
  if (!text || !language) {
    await interactionReply(interaction, "Metin ve geçerli bir hedef dil seçmelisin.", [], true);
    return;
  }
  const result = await translateWithGroq(text, language);
  await interactionReply(
    interaction,
    result
      ? `${translationLanguageLabel(language)}\n\n${result}`
      : "❌ Çeviri şu anda kullanılamıyor. Groq API ayarlarını kontrol et.",
    [],
    true,
  );
}

async function registerCommands(applicationId: string, guildId: string): Promise<void> {
  if (registeredCommandGuilds.has(guildId)) return;
  registeredCommandGuilds.add(guildId);
  try {
    await discordApi(`/applications/${applicationId}/guilds/${guildId}/commands`, {
      method: "PUT",
      body: JSON.stringify([
        {
          name: "link-izni",
          description: "Genel link durumunu ve kullanıcı izinlerini yönetir.",
          type: 1,
          options: [
            {
              name: "durum",
              description: "Sunucudaki link engelini aç veya kapat.",
              type: 1,
              options: [
                {
                  name: "durum",
                  description: "Link paylaşım durumu",
                  type: 3,
                  required: true,
                  choices: [
                    { name: "Aç", value: "ac" },
                    { name: "Kapat", value: "kapat" },
                  ],
                },
              ],
            },
            {
              name: "ekle",
              description: "Bir kullanıcıya link paylaşma izni ver.",
              type: 1,
              options: [
                {
                  name: "kullanici",
                  description: "Link paylaşmasına izin verilecek kullanıcı",
                  type: 6,
                  required: true,
                },
              ],
            },
            {
              name: "cikar",
              description: "Bir kullanıcının link paylaşma iznini kaldır.",
              type: 1,
              options: [
                {
                  name: "kullanici",
                  description: "Link paylaşma izni kaldırılacak kullanıcı",
                  type: 6,
                  required: true,
                },
              ],
            },
            {
              name: "liste",
              description: "Link paylaşma izni olan kullanıcıları göster.",
              type: 1,
            },
          ],
        },
        { name: "sunucu-bilgi", description: "Sunucunun istatistiklerini ve ayarlarını gösterir.", type: 1 },
        {
          name: "oneri",
          name_localizations: { tr: "öneri" },
          description: "FrArda'ya incelenmek üzere öneri gönderir.",
          type: 1,
          options: [
            {
              name: "mesaj",
              description: "Göndermek istediğin öneri",
              type: 3,
              required: true,
              min_length: 5,
              max_length: 1500,
            },
          ],
        },
        {
          name: "kullanici-bilgi",
          description: "Bir kullanıcının hesap ve sunucu üyelik bilgilerini gösterir.",
          type: 1,
          options: [
            { name: "kullanici", description: "Bilgileri gösterilecek kullanıcı", type: 6, required: false },
          ],
        },
        { name: "shop", description: "FR Family Shop menüsünü #mağaza kanalına gönderir.", type: 1, default_member_permissions: "40" },
        { name: "kampanya", description: "FR Family Shop kampanyasını başlatır (sadece yöneticiler).", type: 1, default_member_permissions: "40" },
        { name: "kampanya-bitir", description: "Aktif FR Family Shop kampanyasını bitirir (sadece yöneticiler).", type: 1, default_member_permissions: "40" },
        {
          name: "urun-ekle",
          description: "Bir Discord rolünü FR Family Shop üst rollerine ekler (sadece yöneticiler).",
          type: 1,
          default_member_permissions: "40",
          options: [
            { name: "rol", description: "Mağazaya eklenecek Discord rolü", type: 8, required: true },
            { name: "fiyat", description: "Coin fiyatı", type: 4, required: true, min_value: 1, max_value: 100000000 },
          ],
        },
        {
          name: "urun-kaldir",
          description: "Yönetici tarafından eklenmiş bir rolü mağazadan kaldırır.",
          type: 1,
          default_member_permissions: "40",
          options: [{ name: "rol", description: "Mağazadan kaldırılacak rol", type: 8, required: true }],
        },
        {
          name: "coin-ekle", description: "Bir kullanıcıya coin ekler.", type: 1, default_member_permissions: "32",
          options: [
            { name: "kullanici", description: "Coin verilecek kullanıcı", type: 6, required: true },
            { name: "miktar", description: "Eklenecek coin miktarı", type: 4, required: true, min_value: 1, max_value: 100000000 },
          ],
        },
        { name: "coin", description: "Kendi coin bakiyeni gösterir.", type: 1 },
        {
          name: "ceviri",
          name_localizations: { tr: "çeviri", "en-US": "translate" },
          description: "Metni seçtiğin ülke/dile çevirir.",
          type: 1,
          options: [
            { name: "metin", description: "Çevrilecek metin", type: 3, required: true, max_length: 6000 },
            { name: "dil", description: "Ülke ve dil seçimi", type: 3, required: true, autocomplete: true },
          ],
        },
        { name: "gecmis", name_localizations: { tr: "geçmiş" }, description: "AI konuşma geçmişini DM'de gösterir.", type: 1 },
        {
          name: "siparis-tamamla", description: "Bir FR Family Shop siparişini tamamlandı olarak işaretler.", type: 1, default_member_permissions: "32",
          options: [{ name: "siparis", description: "Sipariş ID", type: 3, required: true }],
        },
      ]),
    });
    logger.info({ guildId }, "FrArda sunucu komutları kaydedildi");
  } catch (error) {
    registeredCommandGuilds.delete(guildId);
    throw error;
  }
}

async function clearGlobalCommands(applicationId: string): Promise<void> {
  await discordApi(`/applications/${applicationId}/commands`, {
    method: "PUT",
    body: JSON.stringify([]),
  });
  logger.info("Eski global Discord komutları temizlendi");
}

function selectedSubcommand(interaction: JsonRecord): JsonRecord | undefined {
  return (interaction.data?.options ?? []).find(
    (option: JsonRecord) => Number(option.type) === 1,
  ) as JsonRecord | undefined;
}

function subcommandOption(subcommand: JsonRecord | undefined, name: string): string | undefined {
  const option = (subcommand?.options ?? []).find(
    (item: JsonRecord) => item.name === name,
  ) as JsonRecord | undefined;
  return option?.value ? String(option.value) : undefined;
}

function commandOption(interaction: JsonRecord, name: string): string | undefined {
  const option = (interaction.data?.options ?? []).find(
    (item: JsonRecord) => item.name === name,
  ) as JsonRecord | undefined;
  return option?.value ? String(option.value) : undefined;
}

function getAllowedLinkUsers(guildId: string): Set<string> {
  let allowedUsers = guildLinkAllowedUsers.get(guildId);
  if (!allowedUsers) {
    allowedUsers = new Set<string>();
    guildLinkAllowedUsers.set(guildId, allowedUsers);
  }
  return allowedUsers;
}



function snowflakeDate(id: string): Date {
  const timestamp = Number((BigInt(id) >> 22n) + 1420070400000n);
  return new Date(timestamp);
}

function formatDate(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "Bilinmiyor";
  return `<t:${Math.floor(date.getTime() / 1000)}:F>`;
}

function formatRelativeDate(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "Bilinmiyor";
  return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

function truncate(value: unknown, maxLength: number): string {
  const text = String(value ?? "").trim();
  if (!text) return "Yok";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function verificationLabel(value: unknown): string {
  return ({
    0: "Yok",
    1: "Düşük",
    2: "Orta",
    3: "Yüksek",
    4: "Çok yüksek",
  } as Record<number, string>)[Number(value)] ?? "Bilinmiyor";
}

function contentFilterLabel(value: unknown): string {
  return ({
    0: "Kapalı",
    1: "Rolü olmayan üyeler",
    2: "Tüm üyeler",
  } as Record<number, string>)[Number(value)] ?? "Bilinmiyor";
}

function premiumTierLabel(value: unknown): string {
  return ({
    0: "Seviye 0",
    1: "Seviye 1",
    2: "Seviye 2",
    3: "Seviye 3",
  } as Record<number, string>)[Number(value)] ?? "Bilinmiyor";
}

function channelMention(channelId: unknown): string {
  return channelId ? `<#${String(channelId)}>` : "Yok";
}

function userAvatarUrl(userId: string, avatarHash: unknown, size = 512): string | undefined {
  if (!avatarHash) return undefined;
  const hash = String(avatarHash);
  const extension = hash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${userId}/${hash}.${extension}?size=${size}`;
}

function userBannerUrl(userId: string, bannerHash: unknown, size = 1024): string | undefined {
  if (!bannerHash) return undefined;
  const hash = String(bannerHash);
  const extension = hash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/banners/${userId}/${hash}.${extension}?size=${size}`;
}

function guildIconUrl(guildId: string, iconHash: unknown, size = 512): string | undefined {
  if (!iconHash) return undefined;
  const hash = String(iconHash);
  const extension = hash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/icons/${guildId}/${hash}.${extension}?size=${size}`;
}

function featureLabels(features: unknown): string {
  const labels: Record<string, string> = {
    COMMUNITY: "Topluluk",
    VERIFIED: "Doğrulanmış",
    PARTNERED: "Partner",
    DISCOVERABLE: "Keşfedilebilir",
    INVITE_SPLASH: "Özel davet görseli",
    ANIMATED_ICON: "Hareketli ikon",
    BANNER: "Sunucu bannerı",
    VANITY_URL: "Özel davet bağlantısı",
    NEWS: "Duyuru kanalları",
    WELCOME_SCREEN_ENABLED: "Hoş geldin ekranı",
    MEMBER_VERIFICATION_GATE_ENABLED: "Üye doğrulama",
    MONETIZATION_ENABLED: "Para kazanma",
  };
  const list = Array.isArray(features)
    ? features.map((feature) => labels[String(feature)] ?? String(feature)).filter(Boolean)
    : [];
  return list.length ? list.join(", ") : "Yok";
}

function userFlagLabels(flags: unknown): string {
  const labels: Record<number, string> = {
    1: "Discord çalışanı",
    2: "Partner sahibi",
    4: "HypeSquad etkinlikleri",
    8: "Bug avcısı seviye 1",
    64: "HypeSquad Bravery",
    128: "HypeSquad Brilliance",
    256: "HypeSquad Balance",
    512: "Erken destekçi",
    16384: "Bug avcısı seviye 2",
    65536: "Erken doğrulanmış bot geliştiricisi",
    131072: "Discord sistemleri",
  };
  const numericFlags = Number(flags ?? 0);
  const result = Object.entries(labels)
    .filter(([flag]) => (numericFlags & Number(flag)) !== 0)
    .map(([, label]) => label);
  return result.length ? result.join(", ") : "Yok";
}

function optionUserId(interaction: JsonRecord): string | undefined {
  const option = (interaction.data?.options ?? []).find((item: JsonRecord) => item.name === "kullanici");
  return option?.value ? String(option.value) : String(interaction.member?.user?.id ?? interaction.user?.id ?? "") || undefined;
}

async function replyEmbed(interaction: JsonRecord, embed: JsonRecord, ephemeral = false): Promise<void> {
  await discordApi(`/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: "POST",
    body: JSON.stringify({ type: 4, data: { embeds: [embed], flags: ephemeral ? 64 : 0 } }),
  });
}

async function handleServerInfo(interaction: JsonRecord, guildId: string): Promise<void> {
  const [guild, channels, roles] = await Promise.all([
    discordApi(`/guilds/${guildId}?with_counts=true`),
    discordApi(`/guilds/${guildId}/channels`),
    discordApi(`/guilds/${guildId}/roles`),
  ]);
  const g = (guild ?? {}) as JsonRecord;
  const channelList = Array.isArray(channels) ? channels as JsonRecord[] : [];
  const roleList = Array.isArray(roles) ? roles as JsonRecord[] : [];
  const textChannels = channelList.filter(c => Number(c.type) === 0).length;
  const announcementChannels = channelList.filter(c => Number(c.type) === 5).length;
  const voiceChannels = channelList.filter(c => Number(c.type) === 2).length;
  const stageChannels = channelList.filter(c => Number(c.type) === 13).length;
  const categoryChannels = channelList.filter(c => Number(c.type) === 4).length;
  const forumChannels = channelList.filter(c => Number(c.type) === 15).length;
  const owner = String(g.owner_id ?? "");
  const memberCount = g.approximate_member_count ?? g.member_count ?? "Bilinmiyor";
  const onlineCount = g.approximate_presence_count ?? "Bilinmiyor";
  const emojiCount = Array.isArray(g.emojis) ? g.emojis.length : "Bilinmiyor";
  const stickerCount = Array.isArray(g.stickers) ? g.stickers.length : "Bilinmiyor";
  const nonEveryoneRoles = roleList
    .filter((role) => String(role.name ?? "") !== "@everyone")
    .sort((a, b) => Number(b.position ?? 0) - Number(a.position ?? 0));
  const rolePreview = nonEveryoneRoles.length
    ? nonEveryoneRoles.slice(0, 12).map((role) => `\`${String(role.name)}\``).join(", ")
    : "Yok";
  const moreRoles = nonEveryoneRoles.length > 12 ? ` (+${nonEveryoneRoles.length - 12} daha)` : "";
  const icon = guildIconUrl(guildId, g.icon);
  const banner = g.banner
    ? `https://cdn.discordapp.com/banners/${guildId}/${String(g.banner)}.png?size=1024`
    : undefined;

  await replyEmbed(interaction, {
    title: `🏰 ${String(g.name ?? "Sunucu")} — Sunucu Bilgisi`,
    description: [
      `Sunucu ID: \`${guildId}\``,
      g.description ? `\n${truncate(g.description, 500)}` : "",
    ].join(""),
    thumbnail: icon ? { url: icon } : undefined,
    image: banner ? { url: banner } : undefined,
    fields: [
      { name: "👑 Sahip", value: owner ? `<@${owner}>` : "Bilinmiyor", inline: true },
      { name: "👥 Üye sayısı", value: String(memberCount), inline: true },
      { name: "🟢 Çevrimiçi", value: String(onlineCount), inline: true },
      { name: "🚀 Takviye", value: `${String(g.premium_subscription_count ?? 0)} • ${premiumTierLabel(g.premium_tier)}`, inline: true },
      { name: "💬 Metin", value: String(textChannels), inline: true },
      { name: "📢 Duyuru", value: String(announcementChannels), inline: true },
      { name: "🔊 Ses", value: String(voiceChannels), inline: true },
      { name: "🎙️ Stage", value: String(stageChannels), inline: true },
      { name: "🗂️ Kategori", value: String(categoryChannels), inline: true },
      { name: "🧵 Forum", value: String(forumChannels), inline: true },
      { name: "🎭 Roller", value: String(nonEveryoneRoles.length), inline: true },
      { name: "😀 Emoji", value: String(emojiCount), inline: true },
      { name: "🏷️ Sticker", value: String(stickerCount), inline: true },
      { name: "🛡️ Doğrulama", value: verificationLabel(g.verification_level), inline: true },
      { name: "🔞 İçerik filtresi", value: contentFilterLabel(g.explicit_content_filter), inline: true },
      { name: "🗓️ Oluşturulma", value: `${formatDate(snowflakeDate(guildId))}\n${formatRelativeDate(snowflakeDate(guildId))}`, inline: true },
      { name: "📍 Kurallar kanalı", value: channelMention(g.rules_channel_id), inline: true },
      { name: "📣 Sistem kanalı", value: channelMention(g.system_channel_id), inline: true },
      { name: "🌐 Dil / özel bağlantı", value: `${String(g.preferred_locale ?? "Bilinmiyor")} • ${g.vanity_url_code ? `discord.gg/${g.vanity_url_code}` : "Yok"}`, inline: true },
      { name: "🎭 Öne çıkan roller", value: `${rolePreview}${moreRoles}`.slice(0, 1024), inline: false },
      { name: "✨ Sunucu özellikleri", value: featureLabels(g.features), inline: false },
    ],
    footer: { text: "FrArda • Sunucu Bilgisi" },
    timestamp: new Date().toISOString(),
  });
}

async function handleUserInfo(interaction: JsonRecord, guildId: string): Promise<void> {
  const userId = optionUserId(interaction);
  if (!userId) {
    await interactionReply(interaction, "Kullanıcı bilgisi alınamadı.", [], true);
    return;
  }
  const [user, member, roles] = await Promise.all([
    discordApi(`/users/${userId}`),
    discordApi(`/guilds/${guildId}/members/${userId}`).catch(() => null),
    discordApi(`/guilds/${guildId}/roles`).catch(() => []),
  ]);
  const u = (user ?? {}) as JsonRecord;
  const m = (member ?? {}) as JsonRecord;
  const roleList = Array.isArray(roles) ? roles as JsonRecord[] : [];
  const roleIds = new Set((Array.isArray(m.roles) ? m.roles : []).map(String));
  const roleNames = roleList
    .filter((role) => roleIds.has(String(role.id)))
    .sort((a, b) => Number(b.position ?? 0) - Number(a.position ?? 0))
    .map((role) => String(role.name))
    .filter((name) => name !== "@everyone");
  const username = String(u.username ?? "Bilinmiyor");
  const displayName = String(u.global_name ?? m.nick ?? username);
  const avatar = userAvatarUrl(userId, u.avatar);
  const banner = userBannerUrl(userId, u.banner);
  const createdAt = snowflakeDate(userId);
  const isMember = Boolean(member);
  const accountType = u.system ? "Discord sistem hesabı" : u.bot ? "Bot hesabı" : "Normal kullanıcı";
  const memberStatus = isMember ? "Evet" : "Hayır";
  const timeout = m.communication_disabled_until
    ? `Var — ${formatDate(m.communication_disabled_until)} (${formatRelativeDate(m.communication_disabled_until)})`
    : "Yok";
  const rolesText = roleNames.length
    ? roleNames.map((name) => `\`${name}\``).join(", ")
    : "Sadece @everyone";

  await replyEmbed(interaction, {
    title: `👤 ${truncate(displayName, 200)} — Kullanıcı Bilgisi`,
    description: [
      `<@${userId}>`,
      `\`${userId}\``,
      `\nSunucuda üye: **${memberStatus}**`,
    ].join(" • "),
    thumbnail: avatar ? { url: avatar } : undefined,
    image: banner ? { url: banner } : undefined,
    fields: [
      { name: "🏷️ Kullanıcı adı", value: `@${username}`, inline: true },
      { name: "🌐 Görünen ad", value: truncate(u.global_name ?? "Yok", 100), inline: true },
      { name: "📝 Sunucu takma adı", value: truncate(m.nick ?? "Yok", 100), inline: true },
      { name: "🤖 Hesap türü", value: accountType, inline: true },
      { name: "📅 Hesap oluşturulma", value: `${formatDate(createdAt)}\n${formatRelativeDate(createdAt)}`, inline: true },
      { name: "📥 Sunucuya katılma", value: m.joined_at ? `${formatDate(m.joined_at)}\n${formatRelativeDate(m.joined_at)}` : "Sunucu üyesi değil", inline: true },
      { name: "🎭 Roller", value: truncate(rolesText, 1024), inline: false },
      { name: "🚦 Timeout", value: timeout, inline: true },
      { name: "📋 Doğrulama bekliyor", value: m.pending ? "Evet" : "Hayır", inline: true },
      { name: "🚀 Nitro takviyesi", value: m.premium_since ? `${formatDate(m.premium_since)}\n${formatRelativeDate(m.premium_since)}` : "Yok", inline: true },
      { name: "🏳️ Kullanıcı rozetleri", value: truncate(userFlagLabels(u.public_flags ?? u.flags), 1024), inline: false },
    ],
    footer: { text: "FrArda • Kullanıcı Bilgisi" },
    timestamp: new Date().toISOString(),
  });
}

async function notifySuggestionOwner(caseData: SuggestionCase): Promise<void> {
  const ownerChannelId = await createDirectMessage(caseData.ownerId);
  caseData.ownerDmChannelId = ownerChannelId;
  await sendMessage(ownerChannelId, {
    content: "Yeni bir öneri inceleme bekliyor.",
    allowed_mentions: { parse: [] },
    embeds: [{
      title: "💡 FrArda • Yeni Öneri",
      description: "Aşağıdaki öneriyi inceleyip kararını seç.",
      color: 0xf59e0b,
      fields: [
        { name: "👤 Gönderen", value: `${caseData.displayName} (<@${caseData.userId}>)\n\`${caseData.userId}\``, inline: false },
        { name: "🏠 Sunucu", value: `\`${caseData.guildId}\``, inline: true },
        { name: "🧾 Öneri numarası", value: `\`${caseData.id}\``, inline: true },
        { name: "💬 Öneri", value: truncate(caseData.suggestion, 1500), inline: false },
      ],
      footer: { text: "Onaylarsan öneri sunucuda yayınlanır; reddedersen gerekçen kullanıcıya DM olarak gönderilir." },
      timestamp: new Date().toISOString(),
    }],
    components: [
      row(
        button(`suggestion_approve:${caseData.id}`, "Öneriyi onayla", 3),
        button(`suggestion_reject:${caseData.id}`, "Reddet", 4),
      ),
    ],
  });
}

async function notifySuggestionUser(caseData: SuggestionCase): Promise<void> {
  const userChannelId = await createDirectMessage(caseData.userId);
  const approved = caseData.status === "approved";
  await sendMessage(userChannelId, {
    content: approved ? "Önerin onaylandı." : "Önerin hakkında karar verildi.",
    allowed_mentions: { parse: [] },
    embeds: [{
      title: approved ? "✅ Önerin onaylandı" : "❌ Önerin reddedildi",
      description: approved && caseData.published
        ? "Önerin FrArda tarafından onaylandı ve sunucuda yayınlandı."
        : approved
          ? "Önerin FrArda tarafından onaylandı ancak yayın kanalına gönderilemedi. Yetkili kontrol etmelidir."
        : "Önerin bu sefer onaylanmadı. Aşağıda FrArda'nın gerekçesini görebilirsin.",
      color: approved ? 0x22c55e : 0xef4444,
      fields: [
        { name: "💡 Gönderdiğin öneri", value: truncate(caseData.suggestion, 1500), inline: false },
        ...(!approved
          ? [{ name: "📌 Gerekçe", value: truncate(caseData.rejectionReason ?? "Gerekçe belirtilmedi.", 1024), inline: false }]
          : []),
      ],
      footer: { text: "FrArda • Öneri sistemi" },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function publishApprovedSuggestion(caseData: SuggestionCase): Promise<void> {
  const channelId = String(process.env.SUGGESTION_CHANNEL_ID ?? "").trim() || caseData.sourceChannelId;
  await sendMessage(channelId, {
    content: "💡 **Yeni öneri onaylandı**",
    allowed_mentions: { parse: [] },
    embeds: [{
      title: "Topluluk Önerisi",
      description: truncate(caseData.suggestion, 4000),
      color: 0x22c55e,
      fields: [
        { name: "Gönderen", value: `<@${caseData.userId}>`, inline: true },
        { name: "Durum", value: "FrArda tarafından onaylandı", inline: true },
      ],
      footer: { text: "FrArda • Onaylanmış öneri" },
      timestamp: new Date().toISOString(),
    }],
  });
}

async function finishSuggestion(
  interaction: JsonRecord,
  caseData: SuggestionCase,
  approved: boolean,
  rejectionReason?: string,
): Promise<void> {
  if (caseData.status !== "pending") {
    await interactionReply(interaction, "Bu öneri için daha önce karar verilmiş.", [], true);
    return;
  }

  caseData.status = approved ? "approved" : "rejected";
  caseData.rejectionReason = rejectionReason?.trim() || undefined;
  caseData.published = false;
  if (approved) {
    try {
      await publishApprovedSuggestion(caseData);
      caseData.published = true;
    } catch (error) {
      logger.warn({ err: error, suggestionId: caseData.id }, "Onaylanan öneri sunucuda yayınlanamadı");
    }
  }
  try {
    await notifySuggestionUser(caseData);
  } catch (error) {
    logger.warn({ err: error, suggestionId: caseData.id }, "Öneri sonucu kullanıcıya DM gönderilemedi");
  }
  await interactionUpdate(
    interaction,
    approved && caseData.published
      ? "✅ Öneri onaylandı; sunucuda yayınlandı ve gönderene DM gönderildi."
      : approved
        ? "⚠️ Öneri onaylandı ancak yayın kanalına gönderilemedi; gönderene DM gönderildi."
        : "❌ Öneri reddedildi; gerekçe gönderene DM olarak iletildi.",
    [],
    [{
      title: approved ? "✅ Öneri onaylandı" : "❌ Öneri reddedildi",
      description: approved && caseData.published
        ? "Öneri yayınlandı ve öneri sahibine bilgi verildi."
        : approved
          ? "Öneri sahibine bilgi verildi ancak yayın kanalına gönderilemedi."
        : `Öneri sahibine bilgi verildi.\n\nGerekçe: ${truncate(caseData.rejectionReason ?? "Belirtilmedi.", 800)}`,
      color: approved ? 0x22c55e : 0xef4444,
      footer: { text: `Öneri: ${caseData.id}` },
    }],
  );
}

async function handleSlashCommand(interaction: JsonRecord): Promise<void> {
  const command = String(interaction.data?.name ?? "");
  const guildId = String(interaction.guild_id ?? "");
  if (command === "gecmis" || command === "geçmiş") {
    if (guildId) {
      await interactionReply(interaction, "📩 `/geçmiş` sadece FrArda ile DM'de kullanılabilir.", [], true);
      return;
    }
    const userId = String(interaction.user?.id ?? "");
    const rows = await getAiHistory(userId, 12);
    if (!rows.length) {
      await interactionReply(interaction, "📚 Henüz kayıtlı bir AI konuşma geçmişin yok.", [], true);
      return;
    }
    const lines = rows.reverse().map((row, index) => {
      const date = new Date(String(row.created_at ?? "")).toLocaleString("tr-TR");
      return `**${index + 1}. ${date}**\n🗣️ ${truncate(String(row.prompt ?? ""), 500)}\n🤖 ${truncate(String(row.response ?? ""), 700)}`;
    });
    await interactionReply(interaction, `📚 **AI Konuşma Geçmişin**\n\n${lines.join("\n\n")}`, [], true);
    return;
  }
  if (command === "ceviri" || command === "çeviri" || command === "translate") {
    await handleTranslationCommand(interaction);
    return;
  }
  if (!guildId) {
    await interactionReply(interaction, "Bu komutlar yalnızca sunucularda kullanılabilir.", [], true);
    return;
  }
  if (command === "sunucu-bilgi") {
    await handleServerInfo(interaction, guildId);
    return;
  }

  if (command === "oneri" || command === "öneri") {
    const suggestion = commandOption(interaction, "mesaj")?.trim() ?? "";
    if (suggestion.length < 5) {
      await interactionReply(interaction, "Önerin en az 5 karakter olmalı.", [], true);
      return;
    }
    const ownerId = await findFrArdaOwner(guildId);
    if (!ownerId) {
      await interactionReply(interaction, "Öneri sistemi şu anda kullanılamıyor; FrArda sahibi ayarlanmamış.", [], true);
      return;
    }
    const user = (interaction.member?.user ?? interaction.user ?? {}) as JsonRecord;
    const caseData: SuggestionCase = {
      id: `suggestion-${guildId}-${String(user.id ?? "user")}-${Date.now()}`,
      guildId,
      sourceChannelId: String(interaction.channel_id ?? ""),
      userId: String(user.id ?? ""),
      username: String(user.username ?? "Bilinmiyor"),
      displayName: String(user.global_name ?? user.username ?? "Bilinmiyor"),
      suggestion,
      ownerId,
      status: "pending",
    };
    suggestionCases.set(caseData.id, caseData);
    try {
      await notifySuggestionOwner(caseData);
      await interactionReply(interaction, "Önerin FrArda'ya gönderildi. Karar verildiğinde sana DM ile bilgi verilecek.", [], true);
    } catch (error) {
      suggestionCases.delete(caseData.id);
      logger.warn({ err: error, suggestionId: caseData.id }, "Öneri FrArda'ya gönderilemedi");
      await interactionReply(interaction, "Öneri gönderilirken bir sorun oluştu. Lütfen daha sonra tekrar dene.", [], true);
    }
    return;
  }

  if (command === "kullanici-bilgi") {
    await handleUserInfo(interaction, guildId);
    return;
  }

  if (command === "shop") {
    if (!hasModeratorPermission(interaction)) {
      await interactionReply(interaction, "Bu komutu yalnızca sunucu yöneticileri kullanabilir.", [], true);
      return;
    }
    await handleShopSlash(interaction, guildId);
    return;
  }

  if (command === "urun-ekle") {
    if (!hasModeratorPermission(interaction)) {
      await interactionReply(interaction, "Bu komutu yalnızca sunucu yöneticileri kullanabilir.", [], true);
      return;
    }
    await loadShopState();
    const role = (interaction.data?.options ?? []).find((item: JsonRecord) => item.name === "rol")?.value;
    const price = Number((interaction.data?.options ?? []).find((item: JsonRecord) => item.name === "fiyat")?.value ?? 0);
    const guildRoles = await discordApi(`/guilds/${guildId}/roles`);
    const roleObj = (Array.isArray(guildRoles) ? guildRoles : []).find((item: JsonRecord) => String(item.id) === String(role));
    if (!roleObj || String(roleObj.name) === "@everyone" || roleObj.managed) {
      await interactionReply(interaction, "❌ Geçerli ve yönetilebilir bir Discord rolü seçmelisin.", [], true);
      return;
    }
    if (!Number.isFinite(price) || price < 1) {
      await interactionReply(interaction, "❌ Geçerli bir coin fiyatı gir.", [], true);
      return;
    }
    await addShopRole(guildId, roleObj, price);
    await interactionReply(interaction, `✅ **${String(roleObj.name)}** üst roller mağazasına eklendi.\n\n**Fiyat:** ${Math.floor(price).toLocaleString("tr-TR")} Coin`, [], true);
    return;
  }

  if (command === "urun-kaldir") {
    if (!hasModeratorPermission(interaction)) {
      await interactionReply(interaction, "Bu komutu yalnızca sunucu yöneticileri kullanabilir.", [], true);
      return;
    }
    await loadShopState();
    const roleId = String((interaction.data?.options ?? []).find((item: JsonRecord) => item.name === "rol")?.value ?? "");
    const removed = await removeShopRole(guildId, roleId);
    await interactionReply(interaction, removed ? "✅ Rol mağazadan kaldırıldı." : "❌ Bu rol yönetici tarafından mağazaya eklenmemiş.", [], true);
    return;
  }

  if (command === "kampanya") {
    if (!hasModeratorPermission(interaction)) {
      await interactionReply(interaction, "Bu komutu yalnızca sunucu yöneticileri kullanabilir.", [], true);
      return;
    }
    const result = await startShopCampaign(guildId, true);
    if (!result.ok) {
      await interactionReply(interaction, `🛍️ Zaten aktif bir kampanya var. İndirim: **%${result.discount ?? shopCampaignDiscount(guildId)}**`, [], true);
      return;
    }
    if (result.messageSent) {
      await interactionReply(interaction, "🛍️ Kampanya başlatıldı. Kampanya duyurusu #kampanyalar kanalına gönderildi ve tüm mağaza GUI'leri yenilendi.", [], true);
    } else {
      await interactionReply(interaction, "⚠️ Kampanya başlatıldı ancak #kampanyalar kanalına mesaj gönderilemedi. Botun kanalda Mesaj Gönder ve Embed Links izinlerini kontrol et.", [], true);
    }
    return;
  }

  if (command === "kampanya-bitir") {
    if (!hasModeratorPermission(interaction)) {
      await interactionReply(interaction, "Bu komutu yalnızca sunucu yöneticileri kullanabilir.", [], true);
      return;
    }
    const ended = await endShopCampaign(guildId, true);
    if (ended) {
      await interactionReply(interaction, "🛍️ Kampanya bitirildi. Fiyatlar normale döndü, mağaza GUI'leri yenilendi ve bitiş duyurusu #kampanyalar kanalına gönderildi.", [], true);
    } else {
      await interactionReply(interaction, "🛍️ Aktif bir kampanya bulunamadı.", [], true);
    }
    return;
  }

  // /coin herkes tarafından kullanılabilir; yönetici yetkisi yalnızca yönetim
  // komutları (coin-ekle, sipariş, vb.) için zorunludur.
  if (command === "coin") {
    await loadShopState();
    const userId = String((interaction.member?.user ?? interaction.user ?? {}).id ?? "");
    const coins = getShopCoins(guildId, userId);
    await interactionReply(interaction, `💰 Bakiyen: **${coins.toLocaleString("tr-TR")} Coin**`, [], true);
    return;
  }

  if (!hasModeratorPermission(interaction)) {
    await interactionReply(
      interaction,
      "Bu komut için Sunucuyu Yönet veya Yönetici yetkisi gerekiyor.",
      [],
      true,
    );
    return;
  }

  if (command === "coin-ekle") {
    await loadShopState();
    const targetId = commandOption(interaction, "kullanici");
    const amount = Number(commandOption(interaction, "miktar") ?? 0);
    if (!targetId || !Number.isFinite(amount) || amount <= 0) {
      await interactionReply(interaction, "Kullanıcı ve geçerli coin miktarı gerekli.", [], true);
      return;
    }
    const before = getShopCoins(guildId, targetId);
    const added = Math.floor(amount);
    const saved = await setShopCoins(guildId, targetId, before + added);
    const after = getShopCoins(guildId, targetId);
    if (!saved || after !== before + added) {
      await interactionReply(interaction, "❌ Coin eklenemedi veya bakiye kaydedilemedi. Sunucu loglarını kontrol et.", [], true);
      return;
    }
    // Kullanıcının açık kişisel mağazası varsa bakiye anında yenilenir.
    await refreshActiveShopSessionForUser(guildId, targetId);
    await interactionReply(interaction, `✅ <@${targetId}> kullanıcısına **${added.toLocaleString("tr-TR")} coin** eklendi. Yeni bakiye: **${after.toLocaleString("tr-TR")} coin**.`, [], true);
    return;
  }

  if (command === "siparis-tamamla") {
    const orderId = commandOption(interaction, "siparis")?.trim() ?? "";
    const finished = await finishShopOrder(guildId, orderId);
    await interactionReply(interaction, finished ? `✅ Sipariş \`${orderId}\` tamamlandı olarak işaretlendi.` : `❌ \`${orderId}\` ID'li aktif sipariş bulunamadı.`, [], true);
    return;
  }

  if (command === "link-izni") {
    const subcommand = selectedSubcommand(interaction);
    const subcommandName = String(subcommand?.name ?? "");
    const allowedUsers = getAllowedLinkUsers(guildId);

    if (subcommandName === "durum") {
      const enabled = subcommandOption(subcommand, "durum") === "ac";
      guildLinkPermissions.set(guildId, enabled);
      await saveGuildSettings(guildId);
      await interactionReply(
        interaction,
        enabled
          ? "Link paylaşımı genel olarak açıldı. İzin listesi değişmeden korunuyor."
          : "Link paylaşımı genel olarak kapatıldı. İzin listesindeki kullanıcılar link atmaya devam edebilir; diğer kullanıcıların linkleri silinip ceza uygulanır.",
      );
      return;
    }

    if (subcommandName === "ekle") {
      const userId = subcommandOption(subcommand, "kullanici");
      if (!userId) {
        await interactionReply(interaction, "İzin verilecek kullanıcıyı seçmelisin.", [], true);
        return;
      }
      if (allowedUsers.has(userId)) {
        await interactionReply(interaction, `<@${userId}> zaten link izin listesinde.`, [], true);
        return;
      }
      allowedUsers.add(userId);
      await saveGuildSettings(guildId);
      await interactionReply(
        interaction,
        `<@${userId}> link izin listesine eklendi. Genel link engeli kapalı olsa bile link paylaşabilir.`,
      );
      return;
    }

    if (subcommandName === "cikar") {
      const userId = subcommandOption(subcommand, "kullanici");
      if (!userId) {
        await interactionReply(interaction, "İzni kaldırılacak kullanıcıyı seçmelisin.", [], true);
        return;
      }
      if (!allowedUsers.delete(userId)) {
        await interactionReply(interaction, `<@${userId}> link izin listesinde bulunmuyor.`, [], true);
        return;
      }
      await saveGuildSettings(guildId);
      await interactionReply(interaction, `<@${userId}> link izin listesinden çıkarıldı.`);
      return;
    }

    if (subcommandName === "liste") {
      if (!allowedUsers.size) {
        await interactionReply(interaction, "Link izin listesi şu anda boş.", [], true);
        return;
      }
      const mentions = [...allowedUsers].map((userId) => `<@${userId}>`);
      await interactionReply(
        interaction,
        `Link paylaşma izni olan kullanıcılar (${mentions.length}):\n${mentions.join(", ")}`,
        [],
        true,
      );
      return;
    }

    await interactionReply(
      interaction,
      "Bir işlem seç: `/link-izni durum`, `/link-izni ekle`, `/link-izni cikar` veya `/link-izni liste`.",
      [],
      true,
    );
    return;
  }

}

async function handleComponent(interaction: JsonRecord): Promise<void> {
  const customId = String(interaction.data?.custom_id ?? "");
  const [action, caseId, value] = customId.split(":");
  const shopUiAction = customId === "shop_open" || customId === "shop_menu" || customId === "shop_back" || action === "shop_product" || customId === "shop_role_select";
  if (shopUiAction) await trackShopSession(interaction, String(interaction.guild_id ?? ""));

  if (action === "shop_finish") {
    const guildId = caseId;
    const orderId = value;
    const ownerId = process.env.FRARDA_OWNER_ID?.trim() || FRARDA_CONTACT_ID;
    if (String(interaction.user?.id ?? "") !== ownerId) {
      await interactionReply(interaction, "❌ Bu siparişi yalnızca FRArda yöneticisi tamamlayabilir.", [], false);
      return;
    }
    await loadShopState();
    const order = shopState.orders.find((item) => item.id === orderId && item.guildId === guildId);
    if (!order) {
      await interactionReply(interaction, "❌ Sipariş bulunamadı.", [], false);
      return;
    }
    if (order.status !== "devam-ediyor") {
      await interactionUpdate(interaction, "ℹ️ Bu sipariş zaten tamamlanmış veya iptal edilmiş.", [row(
          button(`shop_finish:${guildId}:${order.id}`, "✅ Sipariş Tamamlandı", 3, true),
          button(`shop_reject:${guildId}:${order.id}`, "❌ Siparişi Reddet", 4, true),
        )]);
      return;
    }
    const finished = await finishShopOrder(guildId, orderId);
    if (!finished) {
      await interactionReply(interaction, "❌ Sipariş tamamlanırken bir hata oluştu.", [], false);
      return;
    }
    await interactionUpdate(
      interaction,
      `✅ **Sipariş tamamlandı!**\n\n**Sipariş ID:** \`${order.id}\`\n**Ürün:** ${order.product}\n**Tutar:** ${order.price.toLocaleString("tr-TR")} coin\n\n📢 \`#sipariş-aktivasyonu\` kanalına tamamlandı bildirimi gönderildi.`,
      [row(button(`shop_finish:${guildId}:${order.id}`, "✅ Sipariş Tamamlandı", 3, true))],
    );
    return;
  }

  if (action === "shop_reject") {
    const guildId = caseId;
    const orderId = value;
    const ownerId = process.env.FRARDA_OWNER_ID?.trim() || FRARDA_CONTACT_ID;
    if (String(interaction.user?.id ?? "") !== ownerId) {
      await interactionReply(interaction, "❌ Bu siparişi yalnızca FRArda yöneticisi reddedebilir.", [], true);
      return;
    }
    await loadShopState();
    const order = shopState.orders.find((item) => item.id === orderId && item.guildId === guildId);
    if (!order) {
      await interactionReply(interaction, "❌ Sipariş bulunamadı.", [], false);
      return;
    }
    if (order.status !== "devam-ediyor") {
      await interactionReply(interaction, "ℹ️ Bu sipariş zaten tamamlanmış veya reddedilmiş.", [], false);
      return;
    }
    const rejected = await rejectShopOrder(guildId, orderId);
    if (!rejected) {
      await interactionReply(interaction, "❌ Sipariş reddedilirken bir hata oluştu.", [], false);
      return;
    }
    await interactionUpdate(
      interaction,
      `❌ **Sipariş reddedildi ve coin iadesi yapıldı.**\n\n**Sipariş ID:** \`${order.id}\`\n**Ürün:** ${order.product}\n**İade:** ${order.price.toLocaleString("tr-TR")} coin\n\n📢 \`#sipariş-aktivasyonu\` kanalına reddedildi bildirimi gönderildi.`,
      [row(
        button(`shop_finish:${guildId}:${order.id}`, "✅ Sipariş Tamamlandı", 3, true),
        button(`shop_reject:${guildId}:${order.id}`, "❌ Siparişi Reddet", 4, true),
      )],
    );
    return;
  }

  if (action === "shop_confirm_role") {
    const guildId = caseId;
    const roleId = value;
    const user = (interaction.member?.user ?? interaction.user ?? {}) as JsonRecord;
    const roles = await shopRoles(guildId);
    const role = roles.find((item) => String(item.id) === roleId);
    if (!role) { await interactionReply(interaction, "❌ Bu rol artık mağazada bulunmuyor.", [], true); return; }
    const price = shopEffectivePrice(guildId, shopPriceForRole(role, guildId));
    const order = await createShopOrder(guildId, user, `Üst Rol: ${String(role.name)}`, price);
    const coins = getShopCoins(guildId, String(user.id ?? ""));
    if (!order) { await interactionReply(interaction, `❌ Bu rol için **${price.toLocaleString("tr-TR")} coin** gerekiyor. Mevcut bakiyen: **${coins.toLocaleString("tr-TR")}**.`, [], true); return; }
    await interactionUpdate(interaction, `✅ **Sipariş oluşturuldu!**\n\n**Ürün:** ${String(role.name)}\n**Tutar:** ${price.toLocaleString("tr-TR")} Coin\n**Sipariş ID:** \`${order.id}\`\n\n📩 FRArda'ya sipariş detayları gönderildi.`, [row(button("shop_back", "↩️ Mağazaya Dön", 2))], [shopPublicEmbed(getShopCoins(guildId, String(user.id ?? "")), guildId)]);
    return;
  }

  if (action === "shop_confirm_special") {
    const guildId = caseId;
    const user = (interaction.member?.user ?? interaction.user ?? {}) as JsonRecord;
    const price = shopEffectivePrice(guildId, SHOP_SPECIAL_ROLE_PRICE);
    const order = await createShopOrder(guildId, user, "Özel Rol", price);
    const coins = getShopCoins(guildId, String(user.id ?? ""));
    if (!order) { await interactionReply(interaction, `❌ Özel Rol için **${price.toLocaleString("tr-TR")} coin** gerekiyor. Mevcut bakiyen: **${coins.toLocaleString("tr-TR")}**.`, [], true); return; }
    await interactionUpdate(interaction, `✅ **Özel rol siparişin oluşturuldu!**\n\n**Tutar:** ${price.toLocaleString("tr-TR")} Coin\n**Sipariş ID:** \`${order.id}\`\n\n📩 FRArda'ya kullanıcı ve sipariş detayların gönderildi.`, [row(button("shop_back", "↩️ Mağazaya Dön", 2))], [shopPublicEmbed(getShopCoins(guildId, String(user.id ?? "")), guildId)]);
    return;
  }

  if (action === "shop_confirm_product") {
    const guildId = caseId;
    const productKey = value;
    const user = (interaction.member?.user ?? interaction.user ?? {}) as JsonRecord;
    if (productKey !== "nitro") { await interactionReply(interaction, "❌ Bu ürün bulunamadı.", [], true); return; }
    const price = shopEffectivePrice(guildId, SHOP_NITRO_PRICE);
    const order = await createShopOrder(guildId, user, "1 Aylık Discord Nitro", price);
    const coins = getShopCoins(guildId, String(user.id ?? ""));
    if (!order) { await interactionReply(interaction, `❌ Nitro için **${price.toLocaleString("tr-TR")} coin** gerekiyor. Mevcut bakiyen: **${coins.toLocaleString("tr-TR")}**.`, [], true); return; }
    await interactionUpdate(interaction, `✅ **Nitro siparişin oluşturuldu!**\n\n**Tutar:** ${price.toLocaleString("tr-TR")} Coin\n**Sipariş ID:** \`${order.id}\`\n\n📩 FRArda'ya sipariş detayların gönderildi.`, [row(button("shop_back", "↩️ Mağazaya Dön", 2))], [shopPublicEmbed(getShopCoins(guildId, String(user.id ?? "")), guildId)]);
    return;
  }

  if (customId === "shop_open") {
    const guildId = String(interaction.guild_id ?? "");
    const user = (interaction.member?.user ?? interaction.user ?? {}) as JsonRecord;
    await loadShopState();
    const coins = getShopCoins(guildId, String(user.id ?? ""));
    await interactionReply(interaction, "", [row(shopMenu())], true);
    await editInteractionOriginal(interaction, {
      content: "",
      embeds: [shopPublicEmbed(coins, guildId)],
      components: [row(shopMenu())],
    });
    return;
  }

  if (customId === "shop_menu") {
    const guildId = String(interaction.guild_id ?? "");
    const user = (interaction.member?.user ?? interaction.user ?? {}) as JsonRecord;
    const selected = String(interaction.data?.values?.[0] ?? "");
    await loadShopState();
    const coins = getShopCoins(guildId, String(user.id ?? ""));
    if (selected === "roles") {
      const roles = await shopRoles(guildId);
      if (!roles.length) { await interactionReply(interaction, "Şu anda satın alınabilir üst rol bulunamadı.", [], true); return; }
      const options = roles.map((role) => ({ label: String(role.name).slice(0, 100), value: String(role.id), description: `Fiyat: ${shopEffectivePrice(guildId, shopPriceForRole(role, guildId)).toLocaleString("tr-TR")} coin${shopCampaignActive(guildId) ? ` • %${shopCampaignDiscount(guildId)} kampanya` : ""}`.slice(0, 100) }));
      const roleComponents = [{ type: 1, components: [{ type: 3, custom_id: "shop_role_select", placeholder: "👑 Bir üst rol seç...", options }] }, row(button("shop_back", "↩️ Mağazaya Dön", 2))];
      await interactionReply(interaction, "", roleComponents, true);
      await editInteractionOriginal(interaction, { embeds: [shopRolesEmbed(roles, guildId, coins)], components: roleComponents });
      setTimeout(() => {
        void editInteractionOriginal(interaction, { content: "🛍️ İşlem yapılmadığı için mağaza ana menüsüne dönüldü.", embeds: [shopPublicEmbed(coins, guildId)], components: [row(shopMenu())] }).catch(() => undefined);
      }, 60_000);
      return;
    }
    if (selected === "special-role") {
      const specialPrice = shopEffectivePrice(guildId, SHOP_SPECIAL_ROLE_PRICE);
      await interactionReply(interaction, "", [row(button(`shop_confirm_special:${guildId}:special`, "🎨 Özel Rolü Satın Al", 3), button("shop_back", "↩️ Mağazaya Dön", 2))], true);
      await editInteractionOriginal(interaction, { embeds: [shopConfirmEmbed("🎨 Özel Rol", "Özel Rol", specialPrice, coins)], components: [row(button(`shop_confirm_special:${guildId}:special`, "🎨 Özel Rolü Satın Al", 3), button("shop_back", "↩️ Mağazaya Dön", 2))] });
      return;
    }
    if (selected === "other") {
      const nitroPrice = shopEffectivePrice(guildId, SHOP_NITRO_PRICE);
      const otherEmbed = {
        title: "🎁 FR FAMILY SHOP • DİĞER ÜRÜNLER",
        description: `💰 **Bakiyen:** ${coins.toLocaleString("tr-TR")} Coin\n\nŞimdilik mağazada bir ürün bulunuyor.`,
        color: 0x6d4aff,
        image: { url: shopBannerUrl() },
        fields: [{ name: "🚀 1 Aylık Discord Nitro", value: `**${nitroPrice.toLocaleString("tr-TR")} Coin**\nManuel teslimat • Sipariş onayı gerekli`, inline: false }],
        footer: { text: "FR Family Shop • Diğer Ürünler" },
      };
      const otherComponents = [row(button(`shop_product:${guildId}:nitro`, "🎁 Nitro Satın Al", 1), button("shop_back", "↩️ Mağazaya Dön", 2))];
      await interactionReply(interaction, "", otherComponents, true);
      await editInteractionOriginal(interaction, { embeds: [otherEmbed], components: otherComponents });
      setTimeout(() => {
        void editInteractionOriginal(interaction, { content: "🛍️ İşlem yapılmadığı için mağaza ana menüsüne dönüldü.", embeds: [shopPublicEmbed(coins, guildId)], components: [row(shopMenu())] }).catch(() => undefined);
      }, 60_000);
      return;
    }
    if (selected === "buy-coins" || selected === "join") {
      const text = selected === "buy-coins" ? "💰 Coin satın almak için FRArda ile iletişime geçebilirsin. İşlem manuel olarak yapılır." : "📩 Join satın almak için FRArda ile iletişime geçebilirsin. İşlem manuel olarak yapılır.";
      await interactionReply(interaction, text, [row({ type: 2, style: 5, label: "FRArda ile İletişime Geç", url: `https://discord.com/users/${FRARDA_CONTACT_ID}` })], true);
      return;
    }
  }

  if (customId === "shop_back") {
    const guildId = String(interaction.guild_id ?? "");
    const user = (interaction.member?.user ?? interaction.user ?? {}) as JsonRecord;
    const coins = getShopCoins(guildId, String(user.id ?? ""));
    await interactionUpdate(interaction, `🛍️ **FR Family Shop**\n\n💰 Bakiyen: **${coins.toLocaleString("tr-TR")} coin**`, [row(shopMenu())]);
    return;
  }

  if (action === "shop_product") {
    const guildId = caseId;
    const productKey = value;
    const user = (interaction.member?.user ?? interaction.user ?? {}) as JsonRecord;
    if (productKey !== "nitro") {
      await interactionReply(interaction, "❌ Bu ürün bulunamadı.", [], true);
      return;
    }
    await loadShopState();
    const price = shopEffectivePrice(guildId, SHOP_NITRO_PRICE);
    const coins = getShopCoins(guildId, String(user.id ?? ""));
    const components = [row(button(`shop_confirm_product:${guildId}:nitro`, "✅ Nitro Satın Al", 3), button("shop_back", "↩️ Mağazaya Dön", 2))];
    await interactionReply(interaction, "", components, true);
    await editInteractionOriginal(interaction, { embeds: [shopConfirmEmbed("🎁 1 Aylık Discord Nitro", "1 Aylık Discord Nitro", price, coins)], components });
    return;
  }

  if (customId === "shop_role_select") {
    const guildId = String(interaction.guild_id ?? "");
    const user = (interaction.member?.user ?? interaction.user ?? {}) as JsonRecord;
    const roleId = String(interaction.data?.values?.[0] ?? "");
    const roles = await shopRoles(guildId);
    const role = roles.find((item) => String(item.id) === roleId);
    if (!role) { await interactionReply(interaction, "Bu rol artık mağazada bulunmuyor.", [], true); return; }
    const price = shopEffectivePrice(guildId, shopPriceForRole(role, guildId));
    const components = [row(button(`shop_confirm_role:${guildId}:${roleId}`, "✅ Satın Al", 3), button("shop_back", "↩️ Mağazaya Dön", 2))];
    const coins = getShopCoins(guildId, String(user.id ?? ""));
    await interactionReply(interaction, "", components, true);
    await editInteractionOriginal(interaction, { embeds: [shopConfirmEmbed(`👑 ${String(role.name)}`, `Üst Rol: ${String(role.name)}`, price, coins)], components });
    return;
  }

  if (action === "heart") {
    const key = `${interaction.channel_id}:${interaction.message?.id}`;
    if (!heartedMessages.has(key)) {
      heartedMessages.add(key);
      await addHeartReaction(String(interaction.channel_id), String(interaction.message?.id));
    }
    await discordApi(
      `/interactions/${interaction.id}/${interaction.token}/callback`,
      { method: "POST", body: JSON.stringify({ type: 6 }) },
    );
    return;
  }

  const suggestionCase = suggestionCases.get(caseId);
  if (action === "suggestion_approve" || action === "suggestion_reject" || action === "suggestion_reject_modal") {
    if (!suggestionCase) {
      await interactionReply(interaction, "Bu öneri artık geçerli değil.", [], true);
      return;
    }
    if (String(interaction.user?.id ?? "") !== suggestionCase.ownerId) {
      await interactionReply(interaction, "Bu öneri kararı yalnızca FrArda tarafından verilebilir.", [], true);
      return;
    }
    if (action === "suggestion_approve") {
      await finishSuggestion(interaction, suggestionCase, true);
      return;
    }
    if (action === "suggestion_reject") {
      await discordApi(`/interactions/${interaction.id}/${interaction.token}/callback`, {
        method: "POST",
        body: JSON.stringify({
          type: 9,
          data: {
            custom_id: `suggestion_reject_modal:${suggestionCase.id}`,
            title: "Öneriyi Reddet",
            components: [{
              type: 1,
              components: [{
                type: 4,
                custom_id: "rejection_reason",
                label: "Red gerekçesi",
                style: 2,
                min_length: 5,
                max_length: 1000,
                required: true,
                placeholder: "Önerinin neden reddedildiğini açıkla...",
              }],
            }],
          },
        }),
      });
      return;
    }
    const inputs = (interaction.data?.components ?? [])
      .flatMap((r: JsonRecord) => r.components ?? []) as JsonRecord[];
    const rejectionReason = String(
      inputs.find((input) => input.custom_id === "rejection_reason")?.value ?? "",
    ).trim();
    if (rejectionReason.length < 5) {
      await interactionReply(interaction, "Red gerekçesi en az 5 karakter olmalı.", [], true);
      return;
    }
    await finishSuggestion(interaction, suggestionCase, false, rejectionReason);
    return;
  }

  const caseData = moderationCases.get(caseId);
  if (!caseData) {
    await interactionReply(interaction, "Bu itiraz veya sınama artık geçerli değil.", [], true);
    return;
  }

  if (action === "appeal") {
    if (String(interaction.user?.id) !== caseData.userId) { await interactionReply(interaction, "Bu itiraz düğmesi yalnızca ilgili üyeye ait.", [], true); return; }
    if (caseData.appealRequested) { await interactionReply(interaction, "İtirazın zaten iletildi. Yanıt bekleniyor.", [], true); return; }
    await discordApi(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: JSON.stringify({
        type: 9,
        data: {
          custom_id: `appeal_modal:${caseData.id}`,
          title: "İtiraz Talebi",
          components: [{
            type: 1,
            components: [{
              type: 4,
              custom_id: "appeal_reason",
              label: "İtiraz gerekçen",
              style: 2,
              min_length: 5,
              max_length: 1000,
              required: true,
              placeholder: "Ne olduğunu kısa ve açık şekilde anlat...",
            }],
          }],
        },
      }),
    });
    return;
  }

  if (action === "appeal_modal" && interaction.type === 5) {
    if (String(interaction.user?.id) !== caseData.userId) { await interactionReply(interaction, "Bu itiraz yalnızca ilgili üyeye ait.", [], true); return; }
    const inputs = (interaction.data?.components ?? []).flatMap((r: JsonRecord) => r.components ?? []) as JsonRecord[];
    caseData.appealReason = String(inputs.find((v) => v.custom_id === "appeal_reason")?.value ?? "").trim();
    if (caseData.appealReason.length < 5) { await interactionReply(interaction, "İtiraz gerekçen çok kısa.", [], true); return; }
    caseData.appealRequested = true;
    await persistModerationCase(caseData);
    await interactionReply(interaction, "İtirazın alındı ve yetkiliye iletildi. 5 dakika içinde karar verilmezse sana otomatik kural sınaması gönderilecek.", [], true);
    try { await notifyFrArdaOwner(caseData); } catch (error) { logger.warn({ err: error, caseId: caseData.id }, "FrArda sahibine itiraz gönderilemedi"); }
    caseData.responseTimer = setTimeout(() => { void startChallenge(caseData).catch((error) => logger.warn({ err: error, caseId: caseData.id }, "Kural sınaması başlatılamadı")); }, 5 * 60_000);
    return;
  }

  if (action === "appeal_accept" || action === "appeal_reject") {
    if (String(interaction.user?.id) !== caseData.frArdaUserId) {
      await interactionReply(interaction, "Bu moderasyon kararı yalnızca FrArda tarafından verilebilir.", [], true);
      return;
    }
    if (caseData.responseTimer) clearTimeout(caseData.responseTimer);
    const accepted = action === "appeal_accept";
    caseData.status = accepted ? "accepted" : "rejected";
    await persistModerationCase(caseData);
    if (accepted) {
      await timeoutMember(caseData.guildId, caseData.userId, null, "FrArda itirazı kabul etti");
      if (caseData.dmChannelId) {
        await sendMessage(caseData.dmChannelId, {
          content: "İtiraz sonucu",
          embeds: [{
            title: "✅ İtirazın kabul edildi",
            description: "Yapılan inceleme sonucunda itirazın kabul edildi ve timeout işlemin kaldırıldı.",
            color: 0x22c55e,
            fields: [
              { name: "🧾 Vaka", value: `\`${caseData.id}\``, inline: true },
              { name: "📌 Sonuç", value: "Timeout kaldırıldı", inline: true },
              { name: "🔔 Hatırlatma", value: "Lütfen sunucu kurallarına dikkat et. Yeni bir ihlal tekrar işlem uygulanmasına neden olabilir.", inline: false },
            ],
            footer: { text: "FrArda • Moderasyon" },
            timestamp: new Date().toISOString(),
          }],
        });
      }
    } else if (caseData.dmChannelId) {
      await sendMessage(caseData.dmChannelId, {
        content: "İtiraz sonucu",
        embeds: [{
          title: "❌ İtirazın reddedildi",
          description: "Yapılan inceleme sonucunda itirazın reddedildi. Uygulanan timeout süresi devam ediyor.",
          color: 0xef4444,
          fields: [
            { name: "🧾 Vaka", value: `\`${caseData.id}\``, inline: true },
            { name: "⏱️ Timeout bitişi", value: `${formatDate(caseData.timeoutUntil)}\n${formatRelativeDate(caseData.timeoutUntil)}`, inline: true },
            { name: "📌 İlk işlem sebebi", value: truncate(caseData.reason, 1024), inline: false },
          ],
          footer: { text: "FrArda • Moderasyon" },
          timestamp: new Date().toISOString(),
        }],
      });
    }
    await interactionUpdate(
      interaction,
      accepted ? "✅ İtiraz kabul edildi ve timeout kaldırıldı." : "❌ İtiraz reddedildi; timeout devam ediyor.",
      [],
      [{
        title: accepted ? "İtiraz kararı: Kabul" : "İtiraz kararı: Ret",
        description: accepted
          ? "Üyeye bilgi verildi ve timeout kaldırıldı."
          : "Üyeye bilgi verildi; mevcut timeout süresi devam ediyor.",
        color: accepted ? 0x22c55e : 0xef4444,
        footer: { text: `Vaka: ${caseData.id}` },
      }],
    );
    return;
  }

  if (action === "challenge") {
    if (String(interaction.user?.id) !== caseData.userId) {
      await interactionReply(interaction, "Bu sınama yalnızca ilgili üyeye ait.", [], true);
      return;
    }
    const correct = Number(value) === caseData.challengeAnswer;
    if (!correct) {
      const options = caseData.challengeOptions ?? challengeBank[0].options;
      await interactionUpdate(
        interaction,
        "❌ Cevap doğru değil. Tekrar deneyebilirsin.",
        [row(...options.map((option, index) => button(
          `challenge:${caseData.id}:${index}`,
          `Cevap: ${option}`,
        )))],
        [{
          title: "🧠 Tekrar dene",
          description: "Seçtiğin cevap doğru değildi. Kuralları tekrar düşünerek aşağıdaki seçeneklerden birini seç.",
          color: 0xf59e0b,
          footer: { text: `Vaka: ${caseData.id}` },
        }],
      );
      return;
    }
    caseData.status = "accepted";
    await persistModerationCase(caseData);
    await timeoutMember(caseData.guildId, caseData.userId, null, "Kural sınaması başarıyla tamamlandı");
    await interactionUpdate(
      interaction,
      "✅ Sınama tamamlandı; timeout kaldırıldı.",
      [row(button(`heart:${interaction.message?.id}`, "Teşekkür et", 1))],
      [{
        title: "✅ Kural sınaması tamamlandı",
        description: "Cevabın doğru. Bu olay için timeout kaldırıldı ve son uyarı verildi.",
        color: 0x22c55e,
        fields: [
          { name: "🧾 Vaka", value: `\`${caseData.id}\``, inline: true },
          { name: "🔔 Son uyarı", value: "Yeni bir ihlalde tekrar işlem uygulanabilir.", inline: true },
        ],
        footer: { text: "FrArda • Moderasyon" },
      }],
    );
  }
}

async function handleInteraction(interaction: JsonRecord): Promise<void> {
  try {
    if (interaction.type === 2) {
      await handleSlashCommand(interaction);
    } else if (interaction.type === 4) {
      if (String(interaction.data?.name ?? "") === "ceviri" || String(interaction.data?.name ?? "") === "çeviri" || String(interaction.data?.name ?? "") === "translate") {
        await handleTranslationAutocomplete(interaction);
      }
    } else if (interaction.type === 3 || interaction.type === 5) {
      await handleComponent(interaction);
    }
  } catch (error) {
    logger.error({ err: error }, "Discord etkileşimi işlenemedi");
  }
}


async function saveGuildKnowledge(
  guildId: string,
  knowledge: string,
  _info: { name: string; ownerId?: string; memberCount?: number },
): Promise<void> {
  guildKnowledgeCache.set(guildId, {
    knowledge,
    expiresAt: Date.now() + GUILD_KNOWLEDGE_TTL_MS,
  });
}

async function getCachedGuildKnowledge(guildId: string): Promise<string | null> {
  const cached = guildKnowledgeCache.get(guildId);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    guildKnowledgeCache.delete(guildId);
    return null;
  }
  return cached.knowledge;
}

async function rememberUser(message: JsonRecord): Promise<void> {
  const guildId = String(message.guild_id ?? "");
  const userId = String(message.author?.id ?? "");
  if (!guildId || !userId) return;
  const username = String(message.author?.username ?? "Bilinmiyor");
  const displayName = String(message.author?.global_name ?? username);
  userProfileCache.set(`${guildId}:${userId}`, {
    username,
    displayName,
    lastSeenAt: Date.now(),
  });
}

async function getGuildKnowledge(guildId: string): Promise<string> {
  if (!guildId) {
    return "Bu konuşma özel mesajda geçiyor; sunucuya ait kural bağlamı yok.";
  }
  const cached = await getCachedGuildKnowledge(guildId);
  if (cached) return cached;

  try {
    const [guild, channels] = await Promise.all([
      discordApi(`/guilds/${guildId}?with_counts=true`),
      discordApi(`/guilds/${guildId}/channels`),
    ]);
    const g = (guild ?? {}) as JsonRecord;
    const channelList = Array.isArray(channels) ? channels as JsonRecord[] : [];
    const lines: string[] = [
      `Sunucu adı: ${String(g.name ?? "Bilinmiyor")}`,
      `Sunucu ID: ${guildId}`,
      `Üye sayısı: ${String(g.approximate_member_count ?? g.member_count ?? "Bilinmiyor")}`,
      `Sunucu sahibi ID: ${String(g.owner_id ?? "Bilinmiyor")}`,
    ];

    const configuredRulesChannelId = String(g.rules_channel_id ?? "");
    const normalizeChannelName = (value: string) => value
      .toLocaleLowerCase("tr-TR")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/ı/g, "i")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    const isReadableTextChannel = (channel: JsonRecord) =>
      Number(channel.type) === 0 || Number(channel.type) === 5;
    const exactRulesNames = new Set([
      "rules",
      "rule",
      "kural",
      "kurallar",
      "sunucu kurallari",
      "server rules",
    ]);
    const rulesChannels = channelList
      .filter(isReadableTextChannel)
      .sort((a, b) => {
        const aId = String(a.id ?? "");
        const bId = String(b.id ?? "");
        if (aId === configuredRulesChannelId) return -1;
        if (bId === configuredRulesChannelId) return 1;
        const aExact = exactRulesNames.has(normalizeChannelName(String(a.name ?? "")));
        const bExact = exactRulesNames.has(normalizeChannelName(String(b.name ?? "")));
        return Number(bExact) - Number(aExact);
      })
      .filter((channel) => {
        const channelId = String(channel.id ?? "");
        const normalizedName = normalizeChannelName(String(channel.name ?? ""));
        return channelId === configuredRulesChannelId
          || exactRulesNames.has(normalizedName)
          || /(^| )(rules?|kurallar?)( |$)/.test(normalizedName);
      })
      .slice(0, 4);

    for (const channel of rulesChannels) {
      const channelId = String(channel.id);
      const channelName = String(channel.name ?? "kanal");
      try {
        const messages = await discordApi(`/channels/${channelId}/messages?limit=100`);
        const list = Array.isArray(messages) ? messages as JsonRecord[] : [];
        const texts = list
          .reverse()
          .map((m) => {
            const content = String(m.content ?? "").trim();
            const embeds = Array.isArray(m.embeds)
              ? (m.embeds as JsonRecord[])
                .map((embed) => [
                  String(embed.title ?? "").trim(),
                  String(embed.description ?? "").trim(),
                  ...(Array.isArray(embed.fields)
                    ? (embed.fields as JsonRecord[]).map((field) =>
                      `${String(field.name ?? "")}: ${String(field.value ?? "")}`.trim())
                    : []),
                ].filter(Boolean).join("\n"))
                .filter(Boolean)
                .join("\n")
              : "";
            return [content, embeds].filter(Boolean).join("\n");
          })
          .filter(Boolean)
          .join("\n");
        if (texts) lines.push(`Kural/bilgi kanalı #${channelName}:\n${texts.slice(0, 5000)}`);
      } catch (error) {
        logger.debug?.({ err: error, channelId }, "Kural kanalı okunamadı");
      }
    }
    if (!rulesChannels.length) {
      lines.push("Kurallar kanalı bulunamadı. Kurallarla ilgili kesin bilgi uydurma.");
    }
    const knowledge = lines.join("\n").slice(0, 12000);
    await saveGuildKnowledge(guildId, knowledge, {
      name: String(g.name ?? "Bilinmiyor"),
      ownerId: g.owner_id ? String(g.owner_id) : undefined,
      memberCount: Number(g.approximate_member_count ?? g.member_count) || undefined,
    });
    return knowledge;
  } catch (error) {
    logger.warn({ err: error, guildId }, "Sunucu bilgisi AI için alınamadı");
    const cached = await getCachedGuildKnowledge(guildId);
    return cached ?? `Sunucu ID: ${guildId}\nSunucu bilgileri şu anda alınamadı.`;
  }
}

async function chatWithGroq(message: JsonRecord, prompt: string): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  const guildId = String(message.guild_id ?? "");
  const guildKnowledge = await getGuildKnowledge(guildId);
  const author = message.author ?? {};
  const displayName = String(author.global_name ?? author.username ?? "Kullanıcı");
  const historyReply = message.referenced_message?.content
    ? `Yanıtlanan FrArda mesajı:\n${String(message.referenced_message.content).slice(0, 2500)}`
    : "";
  const system = [
    "Sen FrArda isimli Discord sunucu asistanısın.",
    "Türkçe konuş. Samimi, kısa ve doğal cevap ver; gereksiz uzun anlatma.",
    guildId
      ? "Sunucu kanalında yalnızca kullanıcı seni etiketlediğinde veya senin mesajına yanıt verdiğinde konuş."
      : "Bu özel mesaj konuşmasıdır; kullanıcı mesaj gönderdiğinde doğrudan yanıt ver.",
    "Aşağıdaki bağlamda özellikle kurallar kanalı esas alınır. Kullanıcı sunucu/kurallar hakkında sorarsa öncelikle bu bağlama göre cevap ver.",
    "Kurallarda açıkça yazmayan bir şeyi kesin kural gibi uydurma. Bilgin yoksa bunu açıkça söyle.",
    "Kendini Discord botu olarak tanıtabilirsin; FrArda'sın.",
    `Sunucu bağlamı:\n${guildKnowledge}`,
  ].join("\n\n");
  const models = uniqueModels(
    process.env.GROQ_MODEL,
    process.env.GROQ_CHAT_MODEL,
    "llama-3.3-70b-versatile",
  );
  for (const model of models) {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0.7,
          max_tokens: 500,
          messages: [
            { role: "system", content: system },
            { role: "user", content: `${displayName}: ${prompt}\n${historyReply}` },
          ],
        }),
      });
      const responseText = await response.text();
      if (!response.ok) {
        logger.warn({ status: response.status, model }, "Groq sohbet modeli başarısız; diğer model deneniyor");
        continue;
      }
      const body = JSON.parse(responseText) as JsonRecord;
      const text = String(body.choices?.[0]?.message?.content ?? "").trim();
      if (text) return text;
    } catch (error) {
      logger.warn({ err: error, model }, "Groq sohbet modeli başarısız; diğer model deneniyor");
    }
  }
  logger.warn("Groq sohbet modelleri tükendi");
  return null;
}

async function chatWithOpenRouter(message: JsonRecord, prompt: string): Promise<string | null> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return null;
  const guildId = String(message.guild_id ?? "");
  const guildKnowledge = await getGuildKnowledge(guildId);
  const author = message.author ?? {};
  const displayName = String(author.global_name ?? author.username ?? "Kullanıcı");
  const historyReply = message.referenced_message?.content
    ? `Yanıtlanan FrArda mesajı:\n${String(message.referenced_message.content).slice(0, 2500)}`
    : "";
  const system = [
    "Sen FrArda isimli Discord sunucu asistanısın.",
    "Türkçe konuş. Samimi, kısa ve doğal cevap ver; gereksiz uzun anlatma.",
    guildId
      ? "Sunucu kanalında yalnızca kullanıcı seni etiketlediğinde veya senin mesajına yanıt verdiğinde konuş."
      : "Bu özel mesaj konuşmasıdır; kullanıcı mesaj gönderdiğinde doğrudan yanıt ver.",
    "Aşağıdaki bağlamda özellikle kurallar kanalı esas alınır. Kullanıcı sunucu/kurallar hakkında sorarsa öncelikle bu bağlama göre cevap ver.",
    "Kurallarda açıkça yazmayan bir şeyi kesin kural gibi uydurma. Bilgin yoksa bunu açıkça söyle.",
    "Kendini Discord botu olarak tanıtabilirsin; FrArda'sın.",
    `Sunucu bağlamı:\n${guildKnowledge}`,
  ].join("\n\n");
  const model = process.env.OPENROUTER_MODEL?.trim() || "openrouter/free";
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL?.trim() || "https://discord.com",
        "X-Title": process.env.OPENROUTER_APP_NAME?.trim() || "FrArda Discord Bot",
      },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        max_tokens: 500,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `${displayName}: ${prompt}\n${historyReply}` },
        ],
      }),
    });
    const responseText = await response.text();
    if (!response.ok) {
      logger.warn({ status: response.status, model }, "OpenRouter yedek AI başarısız");
      return null;
    }
    const body = JSON.parse(responseText) as JsonRecord;
    const text = String(body.choices?.[0]?.message?.content ?? "").trim();
    return text || null;
  } catch (error) {
    logger.warn({ err: error, model }, "OpenRouter yedek AI isteği başarısız");
    return null;
  }
}

async function sendAiReply(message: JsonRecord, prompt: string): Promise<void> {
  // Öncelik her zaman Groq'ta. Groq limit/HTTP hata/boş cevap verirse ücretsiz OpenRouter fallback devreye girer.
  const groqAnswer = await chatWithGroq(message, prompt);
  const answer = groqAnswer ?? await chatWithOpenRouter(message, prompt);
  if (answer) await saveAiConversation(message, prompt, answer);
  await sendMessage(String(message.channel_id), {
    content: answer ?? "AI bağlantıları şu an kullanılamıyor. Bot yöneticisi GROQ_API_KEY ve OPENROUTER_API_KEY ayarlarını kontrol etmeli.",
    allowed_mentions: { replied_user: false },
    message_reference: { message_id: String(message.id), fail_if_not_exists: false },
  });
}

async function handleAiChat(message: JsonRecord): Promise<boolean> {
  const content = String(message.content ?? "");
  const isDirectMessage = !message.guild_id;
  const mentionPattern = frArdaBotId ? new RegExp(`<@!?${frArdaBotId}>`, "g") : null;
  const mentioned = mentionPattern ? mentionPattern.test(content) : false;
  const repliedToBot = String(message.referenced_message?.author?.id ?? "") === frArdaBotId;
  if (!isDirectMessage && !mentioned && !repliedToBot) return false;

  const prompt = (mentionPattern ? content.replace(mentionPattern, "") : content).trim();
  if (!prompt && !repliedToBot) {
    await sendMessage(String(message.channel_id), { content: "Buradayım. Bana bir şey sor." });
    return true;
  }
  await sendAiReply(message, prompt || "Bu mesaja devam et.");
  return true;
}

function normalizeChannelName(value: string): string {
  return value
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isImageAttachment(attachment: JsonRecord): boolean {
  const contentType = String(attachment.content_type ?? "").toLowerCase();
  const filename = String(attachment.filename ?? "").toLowerCase();
  return contentType.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif)$/i.test(filename);
}

function isVideoAttachment(attachment: JsonRecord): boolean {
  const contentType = String(attachment.content_type ?? "").toLowerCase();
  const filename = String(attachment.filename ?? "").toLowerCase();
  return contentType.startsWith("video/") || /\.(mp4|webm|mov|m4v|mkv|avi)$/i.test(filename);
}

function imageAttachments(message: JsonRecord): JsonRecord[] {
  const attachments = Array.isArray(message.attachments)
    ? message.attachments
    : Object.values((message.attachments ?? {}) as Record<string, JsonRecord>);
  return (attachments as JsonRecord[]).filter((attachment) => {
    return isImageAttachment(attachment);
  });
}

function hasDisallowedLink(content: string): boolean {
  const urls = content.match(URL_PATTERN) ?? [];
  if (!urls.length) return false;
  return urls.some((rawUrl) => {
    const candidate = rawUrl.replace(/[),.!?]+$/g, "");
    try {
      const url = new URL(candidate.startsWith("www.") ? `https://${candidate}` : candidate);
      const host = url.hostname.toLowerCase();
      const path = url.pathname.toLowerCase();
      const isMediaFile = MEDIA_FILE_URL_PATTERN.test(path);
      const isGifProvider = GIF_HOST_PATTERN.test(host) && (host.includes("giphy") || host.includes("tenor") || host.includes("imgur"));
      return !(isMediaFile || isGifProvider);
    } catch {
      return true;
    }
  });
}

async function getMessageChannelName(message: JsonRecord): Promise<string> {
  const rawName = String(message.channel_name ?? message.channel?.name ?? "");
  if (rawName) return normalizeChannelName(rawName);
  const channelId = String(message.channel_id ?? "");
  if (!channelId) return "";
  const cached = channelNameCache.get(channelId);
  if (cached) return cached;
  try {
    const channel = await discordApi(`/channels/${channelId}`);
    const normalized = normalizeChannelName(String((channel as JsonRecord | null)?.name ?? ""));
    if (normalized) channelNameCache.set(channelId, normalized);
    return normalized;
  } catch (error) {
    logger.debug?.({ err: error, channelId }, "Kanal adı alınamadı");
    return "";
  }
}

async function handleGalleryChannel(message: JsonRecord): Promise<boolean> {
  const channelName = await getMessageChannelName(message);
  if (!channelName) return false;

  const attachments = Array.isArray(message.attachments)
    ? message.attachments as JsonRecord[]
    : Object.values((message.attachments ?? {}) as Record<string, JsonRecord>);
  const hasImage = attachments.some(isImageAttachment);
  const hasVideo = attachments.some(isVideoAttachment);

  const channelId = String(message.channel_id);

  async function deleteWithGalleryWarning(text: string): Promise<void> {
    try {
      await deleteMessage(channelId, String(message.id));
    } catch (error) {
      logger.warn({ err: error }, "Galeri mesajı silinemedi");
    }

    try {
      const warning = await sendMessage(channelId, {
        content: text,
        allowed_mentions: { parse: [] },
      });
      const warningId = String(warning?.id ?? "");
      if (warningId) {
        setTimeout(() => {
          void deleteMessage(channelId, warningId).catch((error) => {
            logger.debug?.({ err: error }, "Galeri uyarısı otomatik silinemedi");
          });
        }, 7_000);
      }
    } catch (error) {
      logger.warn({ err: error }, "Galeri uyarısı gönderilemedi");
    }
  }

  if (channelName === "galeri-gorsel") {
    // Görsel galerisinde yalnızca görsel içeren mesajlara izin verilir.
    // Görsel ile birlikte açıklama yazılabilir; video ve düz sohbet mesajları silinir.
    const valid = hasImage && !hasVideo && attachments.every(isImageAttachment);
    if (!valid) {
      await deleteWithGalleryWarning(
        "🖼️ Bu kanalda yalnızca görsel paylaşılabilir. Video paylaşmak için #galeri-video kanalını kullanabilirsin.",
      );
      return true;
    }
    return false;
  }

  if (channelName === "galeri-video") {
    // Video galerisinde yalnızca video içeren mesajlara izin verilir.
    // Fotoğraf/GIF ve düz sohbet mesajları silinir.
    const valid = hasVideo && !hasImage && attachments.every(isVideoAttachment);
    if (!valid) {
      await deleteWithGalleryWarning(
        "🎬 Bu kanalda yalnızca video paylaşılabilir. Fotoğraf paylaşmak için #galeri-gorsel kanalını kullanabilirsin.",
      );
      return true;
    }
    return false;
  }

  return false;
}

async function handleMessage(message: JsonRecord): Promise<void> {
  if (message.author?.bot) return;
  if (!message.guild_id) {
    await handleAiChat(message);
    return;
  }
  const guildId = String(message.guild_id);
  if (await handleCoinMessage(message)) return;
  const authorId = String(message.author?.id ?? "");
  void rememberUser(message);
  const memberPermissions = BigInt(String(message.member?.permissions ?? "0"));
  const isModerator = (memberPermissions & (ADMINISTRATOR | MANAGE_GUILD)) !== 0n;

  // Özel galeri kanalları moderatörlerden bağımsız içerik formatı uygular.
  if (await handleGalleryChannel(message)) return;
  const messageContent = String(message.content ?? "");
  const hasLink = LINK_PATTERN.test(messageContent) && hasDisallowedLink(messageContent);
  const hasPersonalLinkPermission = guildLinkAllowedUsers.get(guildId)?.has(authorId) ?? false;

  if (hasLink && !guildLinkPermissions.get(guildId) && !hasPersonalLinkPermission && !isModerator) {
    await handleViolation(message, "link", "Bu kullanıcı için link paylaşma izni bulunmadığı için engellendi.");
    return;
  }

  // Moderatörler otomatik cezadan muaftır fakat AI sohbetini kullanmaya devam eder.
  // Normal kullanıcıların botu etiketleyerek küfür/18+ içeriği atlatmasını önlemek
  // için önce moderasyon, sonra AI sohbeti çalışır.
  if (!isModerator) {
    const content = messageContent;
    const images = imageAttachments(message);
    if (content.trim() || images.length > 0) {
      const firstImage = images[0];
      const result = await classifyWithGroq(content, firstImage ? String(firstImage.url) : undefined);
      if (result.category !== "clean") {
        await handleViolation(message, result.category, result.reason);
        return;
      }
      for (const image of images.slice(1)) {
        const imageResult = await classifyWithGroq(content, String(image.url));
        if (imageResult.category !== "clean") {
          await handleViolation(message, imageResult.category, imageResult.reason);
          return;
        }
      }
    }
  }

  await handleAiChat(message);
}

async function handleGuildCreate(
  applicationId: string,
  guild: JsonRecord,
): Promise<void> {
  // Bot sunucuya katıldığında artık hiçbir otomatik karşılama/bilgi mesajı göndermez.
  // Sadece slash komutlarını sunucuya kaydeder.
  await registerCommands(applicationId, String(guild.id));
}

async function handleGuildMemberAdd(guildId: string, member: JsonRecord): Promise<void> {
  if (process.env.WELCOME_DM_ENABLED?.toLowerCase() === "false") return;
  const user = (member.user ?? {}) as JsonRecord;
  const userId = String(user.id ?? member.user_id ?? "");
  if (!userId || user.bot) return;
  const welcomeKey = `${guildId}:${userId}`;
  if (welcomeDmSent.has(welcomeKey)) return;
  const existingWelcome = welcomeDmInFlight.get(welcomeKey);
  if (existingWelcome) {
    await existingWelcome;
    return;
  }

  const welcomeWork = (async () => {
    try {
    const [guild, channels] = await Promise.all([
      discordApi(`/guilds/${guildId}?with_counts=true`),
      discordApi(`/guilds/${guildId}/channels`),
    ]);
    const guildData = (guild ?? {}) as JsonRecord;
    const channelList = Array.isArray(channels) ? channels as JsonRecord[] : [];
    const configuredRulesChannelId = String(guildData.rules_channel_id ?? "");
    const rulesChannel = channelList.find((channel) => {
      const name = String(channel.name ?? "")
        .toLocaleLowerCase("tr-TR")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/ı/g, "i")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      return String(channel.id ?? "") === configuredRulesChannelId
        || /(^| )(rules?|kurallar?)( |$)/.test(name);
    });
    const rulesMention = rulesChannel?.id ? `<#${String(rulesChannel.id)}>` : "`rules` veya `kural` kanalı";
    const displayName = String(user.global_name ?? user.username ?? "yeni üyemiz");
    const dmChannelId = await createDirectMessage(userId);
    await sendMessage(dmChannelId, {
      content: `Hoş geldin ${displayName}!`,
      allowed_mentions: { parse: [] },
      embeds: [{
        title: "👋 FrArda • Aramıza hoş geldin",
        description: [
          `**${String(guildData.name ?? "Bu sunucu")}** sunucusuna katıldığın için sevindik.`,
          "",
          `Başlamadan önce sunucu kurallarını ${rulesMention} kanalından okuyabilirsin.`,
          "Bir sorunun olursa bu DM'den doğrudan bana yaz; yapay zekâ sohbeti burada da çalışır.",
          "",
          "İyi eğlenceler!",
        ].join("\n"),
        color: 0x5865f2,
        footer: { text: "FrArda • Sunucu asistanı" },
        timestamp: new Date().toISOString(),
      }],
    });
      welcomeDmSent.add(welcomeKey);
      logger.info({ guildId, userId }, "Yeni üyeye hoş geldin DM'i gönderildi");
    } catch (error) {
      logger.warn({ err: error, guildId, userId }, "Yeni üyeye hoş geldin DM'i gönderilemedi");
    } finally {
      welcomeDmInFlight.delete(welcomeKey);
    }
  })();
  welcomeDmInFlight.set(welcomeKey, welcomeWork);
  await welcomeWork;
}

function connectGateway(token: string): void {
  const Socket = (globalThis as unknown as {
    WebSocket: new (url: string) => RawWebSocket;
  }).WebSocket;
  if (!Socket) {
    logger.error("Node WebSocket istemcisi bulunamadı; Discord botu başlatılamadı");
    return;
  }
  const socket = new Socket(
    `wss://gateway.discord.gg/?v=${GATEWAY_VERSION}&encoding=json`,
  );
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let applicationId = "";
  socket.onopen = () => logger.info("FrArda Discord Gateway bağlantısı açıldı");
  socket.onerror = (error) => logger.error({ err: error }, "Discord Gateway hatası");
  socket.onclose = () => {
    if (heartbeat) clearInterval(heartbeat);
    logger.warn("Discord Gateway bağlantısı kapandı; yeniden bağlanılıyor");
    setTimeout(() => connectGateway(token), 5_000);
  };
  socket.onmessage = (event) => {
    try {
      const payload = JSON.parse(String(event.data)) as JsonRecord;
      if (payload.op === 10) {
        const interval = Number(payload.d.heartbeat_interval);
        heartbeat = setInterval(() => socket.send(JSON.stringify({ op: 1, d: null })), interval);
        socket.send(
          JSON.stringify({
            op: 2,
            d: {
              token,
              intents:
                GUILDS_INTENT |
                GUILD_MEMBERS_INTENT |
                GUILD_MESSAGES_INTENT |
                MESSAGE_CONTENT_INTENT |
                DIRECT_MESSAGES_INTENT,
              properties: { os: "linux", browser: "FrArda", device: "FrArda" },
              presence: {
                status: "online",
                activities: [{ name: "Fr Family’i koruyor", type: 0 }],
              },
            },
          }),
        );
        return;
      }
      if (payload.op === 9) {
        socket.close();
        return;
      }
      if (payload.op !== 0) return;
      const eventName = String(payload.t);
      const data = payload.d as JsonRecord;
      if (eventName === "READY") {
        applicationId = String(data.user?.id ?? "");
        frArdaBotId = applicationId;
        logger.info({ applicationId, guildCount: data.guilds?.length ?? 0 }, "FrArda hazır");
        void clearGlobalCommands(applicationId).catch((error) =>
          logger.warn({ err: error }, "Eski global komutlar temizlenemedi"),
        );
        for (const guild of (data.guilds ?? []) as JsonRecord[]) {
          const guildId = String(guild.id);
          void loadGuildSettings(guildId);
          void registerCommands(applicationId, guildId).catch((error) =>
            logger.warn({ err: error }, "Sunucu komutları kaydedilemedi"),
          );
        }
        void startShopCampaignLoop(((data.guilds ?? []) as JsonRecord[]).map((guild) => String(guild.id)));
      } else if (eventName === "GUILD_CREATE" && applicationId) {
        void handleGuildCreate(applicationId, data).catch((error) =>
          logger.warn({ err: error }, "Yeni sunucu karşılama işlemi başarısız"),
        );
        void loadGuildSettings(String(data.id ?? ""));
        void runCampaignForGuild(String(data.id ?? ""));
      } else if (eventName === "GUILD_MEMBER_ADD") {
        void handleGuildMemberAdd(String(data.guild_id ?? ""), data);
      } else if (eventName === "MESSAGE_CREATE") {
        void handleMessage(data).catch((error) =>
          logger.warn({ err: error }, "Discord mesajı işlenemedi"),
        );
      } else if (eventName === "INTERACTION_CREATE") {
        void handleInteraction(data);
      }
    } catch (error) {
      logger.warn({ err: error }, "Discord Gateway olayı çözümlenemedi");
    }
  };
}

export function startFrArdaBot(): void {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    logger.warn("DISCORD_BOT_TOKEN bulunamadı; FrArda botu başlatılmadı");
    return;
  }
  if (!process.env.GROQ_API_KEY?.trim()) {
    logger.warn("GROQ_API_KEY bulunamadı; FrArda AI sohbeti ve görsel moderasyonu çalışmayacak");
  }
  void ensureDatabase();
  connectGateway(token);
}
