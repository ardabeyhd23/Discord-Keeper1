import { logger } from "./lib/logger";
import { db, guilds, userProfiles, pool } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const DISCORD_API = "https://discord.com/api/v10";
const GATEWAY_VERSION = 10;
const MESSAGE_CONTENT_INTENT = 1 << 15;
const GUILDS_INTENT = 1;
const GUILD_MEMBERS_INTENT = 1 << 1;
const GUILD_MESSAGES_INTENT = 1 << 9;
const DIRECT_MESSAGES_INTENT = 1 << 12;
const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;
const LINK_PATTERN = /(?:https?:\/\/|www\.|discord\.gg\/|t\.me\/|bit\.ly\/)/i;

type JsonRecord = Record<string, any>;

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
  category: "link" | "argo" | "kufur" | "kavga";
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
}

const guildLinkPermissions = new Map<string, boolean>();
const moderationCases = new Map<string, ModerationCase>();
const heartedMessages = new Set<string>();
const registeredCommandGuilds = new Set<string>();
let frArdaBotId = "";
const frArdaCache = new Map<
  string,
  { member: JsonRecord | null; expiresAt: number }
>();



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
    .replace(/[4@]/g, "a").replace(/[1!|]/g, "i").replace(/[3]/g, "e")
    .replace(/[5$]/g, "s").replace(/[0]/g, "o").replace(/[7]/g, "t")
    .replace(/[^a-z0-9çğıöşü\s]/gi, " ").replace(/\s+/g, " ").trim();
}

function hasObfuscatedWord(text: string, words: string[]): boolean {
  const compact = normalizeForModeration(text).replace(/\s+/g, "");
  return words.some((word) => compact.includes(normalizeForModeration(word).replace(/\s+/g, "")));
}

function fallbackClassification(text: string): {
  category: "clean" | "argo" | "kufur" | "kavga";
  reason: string;
} {
  const normalized = normalizeForModeration(text);
  const profanity = ["amk", "aq", "sik", "siktir", "orospu", "pic", "yarrak", "ibne", "gerizekali"];
  const slang = ["salak", "aptal", "mal", "ulan", "ezik"];
  const fight = ["dov", "kavga", "saldir", "oldur", "tehdit", "vuracagim", "dayak"];
  if (fight.some((word) => normalized.includes(word))) return { category: "kavga", reason: "Kavga veya tehdit ifadesi algılandı." };
  if (hasObfuscatedWord(text, profanity)) return { category: "kufur", reason: "Küfür veya ağır hakaret algılandı." };
  if (slang.some((word) => normalized.includes(word))) return { category: "argo", reason: "Argo veya hafif hakaret algılandı." };
  return { category: "clean", reason: "" };
}

async function classifyWithGroq(
  content: string,
  imageUrl?: string,
): Promise<{ category: "clean" | "argo" | "kufur" | "kavga"; reason: string }> {
  const fallback = fallbackClassification(content);
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return fallback;

  const messageContent: JsonRecord[] = [
    {
      type: "text",
      text: [
        "Sen FrArda Discord moderasyon yardımcısısın.",
        "Mesajı Türkçe bağlamıyla değerlendir.",
        'Sadece şu JSON formatında cevap ver: {"category":"clean|argo|kufur|kavga","reason":"kısa Türkçe açıklama"}',
        "clean: kural ihlali yok; argo: hafif argo/hakaret; kufur: açık küfür/ağır hakaret; kavga: tehdit, şiddet çağrısı veya kavga kışkırtması.",
        `Mesaj: ${content || "(görsel gönderildi)"}`,
      ].join("\n"),
    },
  ];
  if (imageUrl) {
    messageContent.push({ type: "image_url", image_url: { url: imageUrl } });
  }

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model:
          process.env.GROQ_MODEL ?? "meta-llama/llama-4-scout-17b-16e-instruct",
        temperature: 0,
        max_tokens: 160,
        messages: [{ role: "user", content: messageContent }],
      }),
    });
    if (!response.ok) throw new Error(`Groq API ${response.status}`);
    const body = (await response.json()) as JsonRecord;
    const raw = String(body.choices?.[0]?.message?.content ?? "");
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()) as JsonRecord;
    const category = ["clean", "argo", "kufur", "kavga"].includes(
      String(parsed.category),
    )
      ? (String(parsed.category) as "clean" | "argo" | "kufur" | "kavga")
      : fallback.category;
    return { category, reason: String(parsed.reason ?? fallback.reason) };
  } catch (error) {
    logger.warn({ err: error }, "Groq değerlendirmesi başarısız, yerel kontrol kullanılıyor");
    return fallback;
  }
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
  try {
    await pool.query(`INSERT INTO moderation_cases
      (case_id,guild_id,channel_id,user_id,category,duration_ms,reason,timeout_until,status,appeal_requested,appeal_reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (case_id) DO UPDATE SET status=EXCLUDED.status, appeal_requested=EXCLUDED.appeal_requested, appeal_reason=EXCLUDED.appeal_reason, updated_at=NOW()`,
      [caseData.id,caseData.guildId,caseData.channelId,caseData.userId,caseData.category,caseData.durationMs,caseData.reason,caseData.timeoutUntil,caseData.status,Boolean(caseData.appealRequested),caseData.appealReason ?? null]);
  } catch (error) {
    logger.warn({ err: error, caseId: caseData.id }, "Moderasyon vakası DB'ye kaydedilemedi");
  }
}

async function notifyFrArdaOwner(caseData: ModerationCase): Promise<void> {
  const ownerId = await findFrArdaOwner(caseData.guildId);
  if (!ownerId) return;
  caseData.frArdaUserId = ownerId;
  const channelId = await createDirectMessage(ownerId);
  const appeal = caseData.appealReason ? `\n\nÜyenin itirazı:\n${caseData.appealReason.slice(0, 1500)}` : "";
  await sendMessage(channelId, {
    content: `FrArda moderasyon itirazı: <@${caseData.userId}> kullanıcısı itiraz etti.${appeal}`,
    embeds: [{ title: "FrArda • Moderasyon İtirazı", description: `Kategori: **${caseData.category}**\nGerekçe: ${caseData.reason}\nVaka: \`${caseData.id}\``, color: 0xeab308, footer: { text: "5 dakika içinde karar verilmezse kullanıcıya kural sınaması gönderilir." } }],
    components: [row(button(`appeal_accept:${caseData.id}`, "İtirazı kabul et", 3), button(`appeal_reject:${caseData.id}`, "Reddet", 4))],
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
  await persistModerationCase(caseData);
  caseData.challengeAnswer = challenge.answer;
  const message = await sendMessage(caseData.dmChannelId, {
    content:
      "FrArda 5 dakika içinde yanıt vermedi. Aşağıdaki soruyu doğru cevaplayarak bu olay için son uyarıyı tamamla:",
    embeds: [
      {
        title: "Kural hatırlatma sınaması",
        description: challenge.question,
        color: 0x38bdf8,
      },
    ],
    components: [
      row(...challenge.options.map((option, index) => button(
        `challenge:${caseData.id}:${index}`,
        option,
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
      content: `FrArda moderasyon bildirimi: ${durationLabel(durationMs)} susturuldun.`,
      embeds: [
        {
          title: "Kural ihlali işlemi",
          description: `${reason}\n\nİtiraz etmek istiyorsan aşağıdaki düğmeye bas. İtirazın FrArda’ya iletilecek.`,
          color: 0xef4444,
          footer: { text: `Vaka: ${caseData.id}` },
        },
      ],
      components: [row(button(`appeal:${caseData.id}`, "İtiraz et", 1))],
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

async function interactionUpdate(
  interaction: JsonRecord,
  content: string,
  components: JsonRecord[] = [],
): Promise<void> {
  await discordApi(
    `/interactions/${interaction.id}/${interaction.token}/callback`,
    {
      method: "POST",
      body: JSON.stringify({ type: 7, data: { content, components } }),
    },
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
          description: "Bu sunucuda link paylaşımını açar veya kapatır.",
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
        { name: "sunucu-bilgi", description: "Sunucu hakkında gelişmiş bilgi gösterir.", type: 1 },
        {
          name: "kullanici-bilgi",
          description: "Bir kullanıcı hakkında gelişmiş bilgi gösterir.",
          type: 1,
          options: [
            { name: "kullanici", description: "Bilgileri gösterilecek kullanıcı", type: 6, required: false },
          ],
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

function optionValue(interaction: JsonRecord, name: string): string | undefined {
  const options = interaction.data?.options ?? [];
  return options.find((option: JsonRecord) => option.name === name)?.value as
    | string
    | undefined;
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
  const textChannels = channelList.filter(c => Number(c.type) === 0 || Number(c.type) === 5).length;
  const voiceChannels = channelList.filter(c => Number(c.type) === 2 || Number(c.type) === 13).length;
  const categoryChannels = channelList.filter(c => Number(c.type) === 4).length;
  const owner = String(g.owner_id ?? "");
  const features = Array.isArray(g.features) && g.features.length ? g.features.join(", ") : "Yok";

  await replyEmbed(interaction, {
    title: `🏰 ${String(g.name ?? "Sunucu")} — Gelişmiş Bilgi`,
    description: `Sunucu ID: \`${guildId}\``,
    fields: [
      { name: "👑 Sahip", value: owner ? `<@${owner}>` : "Bilinmiyor", inline: true },
      { name: "👥 Üyeler", value: String(g.approximate_member_count ?? g.member_count ?? "Bilinmiyor"), inline: true },
      { name: "🤖 Botlar", value: String(g.approximate_presence_count ?? "Bilinmiyor"), inline: true },
      { name: "💬 Metin Kanalları", value: String(textChannels), inline: true },
      { name: "🔊 Ses Kanalları", value: String(voiceChannels), inline: true },
      { name: "📁 Kategoriler", value: String(categoryChannels), inline: true },
      { name: "🎭 Roller", value: String(roleList.length), inline: true },
      { name: "🛡️ Doğrulama", value: String(g.verification_level ?? "Bilinmiyor"), inline: true },
      { name: "📅 Oluşturulma", value: formatDate(snowflakeDate(guildId)), inline: false },
      { name: "✨ Özellikler", value: features.slice(0, 1024), inline: false },
    ],
    footer: { text: "FrArda • Gelişmiş Sunucu Bilgisi" },
    timestamp: new Date().toISOString(),
  });
}

async function handleUserInfo(interaction: JsonRecord, guildId: string): Promise<void> {
  const userId = optionUserId(interaction);
  if (!userId) return;
  const [user, member, roles] = await Promise.all([
    discordApi(`/users/${userId}`),
    discordApi(`/guilds/${guildId}/members/${userId}`),
    discordApi(`/guilds/${guildId}/roles`),
  ]);
  const u = (user ?? {}) as JsonRecord;
  const m = (member ?? {}) as JsonRecord;
  const roleList = Array.isArray(roles) ? roles as JsonRecord[] : [];
  const roleIds = new Set((Array.isArray(m.roles) ? m.roles : []).map(String));
  const roleNames = roleList.filter(r => roleIds.has(String(r.id))).map(r => String(r.name)).filter(Boolean);
  const username = String(u.username ?? "Bilinmiyor");
  const displayName = String(u.global_name ?? m.nick ?? username);
  const avatar = u.avatar ? `https://cdn.discordapp.com/avatars/${userId}/${u.avatar}.png?size=256` : undefined;
  const created = formatDate(snowflakeDate(userId));

  await replyEmbed(interaction, {
    title: `👤 ${displayName} — Kullanıcı Bilgisi`,
    description: `<@${userId}> • \`${userId}\``,
    thumbnail: avatar ? { url: avatar } : undefined,
    fields: [
      { name: "🏷️ Kullanıcı Adı", value: `@${username}`, inline: true },
      { name: "📝 Sunucu Takma Adı", value: String(m.nick ?? "Yok"), inline: true },
      { name: "🤖 Bot", value: u.bot ? "Evet" : "Hayır", inline: true },
      { name: "📅 Hesap Oluşturulma", value: created, inline: true },
      { name: "📥 Sunucuya Katılma", value: m.joined_at ? formatDate(m.joined_at) : "Bilinmiyor", inline: true },
      { name: "🎭 Roller", value: roleNames.length ? roleNames.map(r => `\`${r}\``).join(", ").slice(0, 1024) : "Sadece @everyone", inline: false },
      { name: "🚦 Durum", value: m.communication_disabled_until ? `Timeout: ${formatDate(m.communication_disabled_until)}` : "Normal", inline: true },
    ],
    footer: { text: "FrArda • Gelişmiş Kullanıcı Bilgisi" },
    timestamp: new Date().toISOString(),
  });
}

async function handleSlashCommand(interaction: JsonRecord): Promise<void> {
  const command = String(interaction.data?.name ?? "");
  const guildId = String(interaction.guild_id ?? "");
  if (!guildId) {
    await interactionReply(interaction, "Bu komutlar yalnızca sunucularda kullanılabilir.", [], true);
    return;
  }
  if (command === "sunucu-bilgi") {
    await handleServerInfo(interaction, guildId);
    return;
  }

  if (command === "kullanici-bilgi") {
    await handleUserInfo(interaction, guildId);
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

  if (command === "link-izni") {
    const enabled = optionValue(interaction, "durum") === "ac";
    guildLinkPermissions.set(guildId, enabled);
    await interactionReply(
      interaction,
      enabled
        ? "Link paylaşımı açıldı. FrArda artık linkleri engellemeyecek."
        : "Link paylaşımı kapatıldı. İzin verilmemiş linkler silinecek ve işlem uygulanacak.",
    );
    return;
  }

}

async function handleComponent(interaction: JsonRecord): Promise<void> {
  const customId = String(interaction.data?.custom_id ?? "");
  const [action, caseId, value] = customId.split(":");

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

  const caseData = moderationCases.get(caseId);
  if (!caseData) {
    await interactionReply(interaction, "Bu itiraz veya sınama artık geçerli değil.", [], true);
    return;
  }

  if (action === "appeal") {
    if (String(interaction.user?.id) !== caseData.userId) { await interactionReply(interaction, "Bu itiraz düğmesi yalnızca ilgili üyeye ait.", [], true); return; }
    if (caseData.appealRequested) { await interactionReply(interaction, "İtirazın zaten iletildi. Yanıt bekleniyor.", [], true); return; }
    await discordApi(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST", body: JSON.stringify({ type: 9, data: { custom_id: `appeal_modal:${caseData.id}`, title: "Moderasyon İtirazı", components: [{ type: 1, components: [{ type: 4, custom_id: "appeal_reason", label: "Neden itiraz ediyorsun?", style: 2, min_length: 5, max_length: 1000, required: true, placeholder: "Kısaca açıklayabilirsin..." }] }] } })
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
    await interactionReply(interaction, "İtirazın FrArda sahibine iletildi. 5 dakika içinde cevap gelmezse sana kural sınaması gönderilecek.", [], true);
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
          content: "FrArda itirazını kabul etti. Susturma işlemin kaldırıldı; lütfen kurallara uy.",
        });
      }
    } else if (caseData.dmChannelId) {
      await sendMessage(caseData.dmChannelId, {
        content: "FrArda itirazını reddetti. Uygulanan susturma süresi devam ediyor.",
      });
    }
    await interactionUpdate(
      interaction,
      accepted ? "İtiraz kabul edildi ve susturma kaldırıldı." : "İtiraz reddedildi.",
      [],
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
      await interactionUpdate(
        interaction,
        "Cevap doğru değil. Kuralları okuyup tekrar denemelisin.",
        [row(button(`challenge:${caseData.id}:${caseData.challengeAnswer}`, "Tekrar dene"))],
      );
      return;
    }
    caseData.status = "accepted";
    await persistModerationCase(caseData);
    await timeoutMember(caseData.guildId, caseData.userId, null, "Kural sınaması başarıyla tamamlandı");
    await interactionUpdate(
      interaction,
      "Doğru cevaplandı. Bu olay için son uyarı verildi; lütfen tekrar kural ihlali yapma.",
      [row(button(`heart:${interaction.message?.id}`, "Kalp bırak", 1))],
    );
  }
}

async function handleInteraction(interaction: JsonRecord): Promise<void> {
  try {
    if (interaction.type === 2) {
      await handleSlashCommand(interaction);
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
  info: { name: string; ownerId?: string; memberCount?: number },
): Promise<void> {
  try {
    await db.insert(guilds).values({
      guildId,
      name: info.name,
      ownerId: info.ownerId ?? null,
      memberCount: info.memberCount ?? null,
      knowledge,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: guilds.guildId,
      set: {
        name: info.name,
        ownerId: info.ownerId ?? null,
        memberCount: info.memberCount ?? null,
        knowledge,
        updatedAt: new Date(),
      },
    });
  } catch (error) {
    logger.warn({ err: error, guildId }, "Sunucu bilgisi veritabanına kaydedilemedi");
  }
}

async function getCachedGuildKnowledge(guildId: string): Promise<string | null> {
  try {
    const rows = await db.select({ knowledge: guilds.knowledge })
      .from(guilds)
      .where(eq(guilds.guildId, guildId))
      .limit(1);
    return rows[0]?.knowledge ?? null;
  } catch (error) {
    logger.warn({ err: error, guildId }, "Sunucu bilgisi veritabanından okunamadı");
    return null;
  }
}

async function rememberUser(message: JsonRecord): Promise<void> {
  const guildId = String(message.guild_id ?? "");
  const userId = String(message.author?.id ?? "");
  if (!guildId || !userId) return;
  const username = String(message.author?.username ?? "Bilinmiyor");
  const displayName = String(message.author?.global_name ?? username);
  try {
    await db.insert(userProfiles).values({
      guildId, userId, username, displayName, lastSeenAt: new Date(),
    }).onConflictDoUpdate({
      target: [userProfiles.guildId, userProfiles.userId],
      set: { username, displayName, lastSeenAt: new Date() },
    });
  } catch (error) {
    logger.debug?.({ err: error, guildId, userId }, "Kullanıcı profili kaydedilemedi");
  }
}

async function getGuildKnowledge(guildId: string): Promise<string> {
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

    const rulesChannels = channelList.filter((c) => {
      const name = String(c.name ?? "").toLocaleLowerCase("tr-TR");
      const topic = String(c.topic ?? "").toLocaleLowerCase("tr-TR");
      return /kural|rules|kurallar|bilgi|duyuru/.test(name) || /kural|rules|kurallar/.test(topic);
    }).slice(0, 4);

    for (const channel of rulesChannels) {
      const channelId = String(channel.id);
      const channelName = String(channel.name ?? "kanal");
      try {
        const messages = await discordApi(`/channels/${channelId}/messages?limit=20`);
        const list = Array.isArray(messages) ? messages as JsonRecord[] : [];
        const texts = list
          .reverse()
          .map((m) => String(m.content ?? "").trim())
          .filter(Boolean)
          .join("\n");
        if (texts) lines.push(`Kural/bilgi kanalı #${channelName}:\n${texts.slice(0, 5000)}`);
      } catch (error) {
        logger.debug?.({ err: error, channelId }, "Kural kanalı okunamadı");
      }
    }
    const knowledge = lines.join("\n").slice(0, 9000);
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
    "Bu konuşma sadece kullanıcı seni etiketlediğinde veya senin mesajına yanıt verdiğinde yapılır.",
    "Sunucunun bilgileri ve kuralları aşağıdaki bağlamdadır. Kullanıcı sunucu/kurallar hakkında sorarsa öncelikle bu bağlama göre cevap ver.",
    "Kurallarda açıkça yazmayan bir şeyi kesin kural gibi uydurma. Bilgin yoksa bunu açıkça söyle.",
    "Kendini Discord botu olarak tanıtabilirsin; FrArda'sın.",
    `Sunucu bağlamı:\n${guildKnowledge}`,
  ].join("\n\n");
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.GROQ_CHAT_MODEL ?? process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
        temperature: 0.7,
        max_tokens: 500,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `${displayName}: ${prompt}\n${historyReply}` },
        ],
      }),
    });
    if (!response.ok) throw new Error(`Groq chat API ${response.status}`);
    const body = (await response.json()) as JsonRecord;
    const text = String(body.choices?.[0]?.message?.content ?? "").trim();
    return text || null;
  } catch (error) {
    logger.warn({ err: error }, "Groq sohbet yanıtı başarısız");
    return null;
  }
}

async function handleAiChat(message: JsonRecord): Promise<boolean> {
  const content = String(message.content ?? "");
  const authorId = String(message.author?.id ?? "");
  const mentionPattern = frArdaBotId ? new RegExp(`<@!?${frArdaBotId}>`, "g") : null;
  const mentioned = mentionPattern ? mentionPattern.test(content) : false;
  const repliedToBot = String(message.referenced_message?.author?.id ?? "") === frArdaBotId;
  if (!mentioned && !repliedToBot) return false;

  const prompt = (mentionPattern ? content.replace(mentionPattern, "") : content).trim();
  if (!prompt && !repliedToBot) {
    await sendMessage(String(message.channel_id), { content: "Buradayım 😎 Bana bir şey sor." });
    return true;
  }
  const answer = await chatWithGroq(message, prompt || "Bu mesaja devam et.");
  await sendMessage(String(message.channel_id), {
    content: answer ?? "Şu an cevap oluşturamadım, biraz sonra tekrar dene.",
    allowed_mentions: { replied_user: false },
    message_reference: { message_id: String(message.id), fail_if_not_exists: false },
  });
  return true;
}

async function handleMessage(message: JsonRecord): Promise<void> {
  if (!message.guild_id || message.author?.bot) return;
  const guildId = String(message.guild_id);
  void rememberUser(message);
  if (await handleAiChat(message)) return;
  const memberPermissions = BigInt(String(message.member?.permissions ?? "0"));
  const isModerator = (memberPermissions & (ADMINISTRATOR | MANAGE_GUILD)) !== 0n;
  const hasLink = LINK_PATTERN.test(String(message.content ?? ""));

  if (hasLink && !guildLinkPermissions.get(guildId) && !isModerator) {
    await handleViolation(message, "link", "Bu sunucuda link paylaşımı komutla açılmadığı için engellendi.");
    return;
  }

  const image = Object.values((message.attachments ?? {}) as Record<string, JsonRecord>).find(
    (attachment) => String(attachment.content_type ?? "").startsWith("image/"),
  );
  if (!String(message.content ?? "").trim() && !image) return;
  const result = await classifyWithGroq(
    String(message.content ?? ""),
    image ? String(image.url) : undefined,
  );
  if (result.category !== "clean") {
    await handleViolation(message, result.category, result.reason);
  }
}

async function handleGuildCreate(
  applicationId: string,
  guild: JsonRecord,
): Promise<void> {
  await registerCommands(applicationId, String(guild.id));
  const ownerId = String(guild.owner_id ?? "");
  if (ownerId) {
    await sendMessage(String(guild.system_channel_id ?? ""), {
      content: `FrArda sunucuya katıldı. Hoş geldin ${ownerId ? `<@${ownerId}>` : ""}! Link ve kural moderasyonu hazır.`,
      allowed_mentions: { users: ownerId ? [ownerId] : [] },
    }).catch(() => undefined);
  }
}

async function sendWelcomeMessage(guildId: string, userId: string): Promise<void> {
  const guild = (await discordApi(`/guilds/${guildId}`)) as JsonRecord;
  const channelId = String(guild.system_channel_id ?? "");
  if (!channelId) return;
  await sendMessage(channelId, {
    content: `Fr Family'e hoş geldin <@${userId}>! Kurallara göz atmayı unutma.`,
    allowed_mentions: { users: [userId] },
  });
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
          void registerCommands(applicationId, String(guild.id)).catch((error) =>
            logger.warn({ err: error }, "Sunucu komutları kaydedilemedi"),
          );
        }
      } else if (eventName === "GUILD_CREATE" && applicationId) {
        void handleGuildCreate(applicationId, data).catch((error) =>
          logger.warn({ err: error }, "Yeni sunucu karşılama işlemi başarısız"),
        );
      } else if (eventName === "GUILD_MEMBER_ADD") {
        void sendWelcomeMessage(
          String(data.guild_id),
          String(data.user?.id),
        ).catch((error) =>
          logger.warn({ err: error }, "Yeni üyeye hoş geldin mesajı gönderilemedi"),
        );
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
  connectGateway(token);
}