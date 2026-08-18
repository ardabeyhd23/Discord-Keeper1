import { logger } from "./lib/logger";

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
    return imageUrl
      ? { category: "gorsel", reason: "Görsel güvenlik servisi yapılandırılmadığı için görsel engellendi." }
      : fallback;
  }

  const messageContent: JsonRecord[] = [
    {
      type: "text",
      text: [
        "Sen FrArda Discord moderasyon yardımcısısın.",
        "Mesajı Türkçe bağlamıyla değerlendir.",
        'Sadece şu JSON formatında cevap ver: {"category":"clean|argo|kufur|kavga|cinsel","reason":"kısa Türkçe açıklama","matched":"mesajdaki gerçek kelime veya görseldeki kısa açıklama"}',
        "clean: kural ihlali yok.",
        "argo: hafif argo/hakaret.",
        "kufur: açık küfür/ağır hakaret.",
        "kavga: tehdit, şiddet çağrısı veya kavga kışkırtması.",
        "cinsel: çıplaklık, cinsel organ, cinsel eylem, pornografik veya açıkça 18+ içerik.",
        "ÇOK ÖNEMLİ: Mesajda açıkça bulunmayan bir hakareti varsayma. Şüphede clean seç.",
        "Görsel varsa çıplaklık veya cinsel eylem görüp görmediğini dikkatle kontrol et. Görsel yoksa görsel kuralını uygulama.",
        "matched alanına mesajdaki gerçek kelimeyi veya görseldeki açık ihlalin kısa açıklamasını yaz. clean ise boş bırak.",
        `Mesaj: ${content || "(görsel gönderildi)"}`,
      ].join("\n"),
    },
  ];
  if (imageUrl) {
    messageContent.push({ type: "image_url", image_url: { url: imageUrl } });
  }

  const models = imageUrl
    ? uniqueModels(
        process.env.GROQ_VISION_MODEL,
        process.env.GROQ_MODEL,
        "meta-llama/llama-4-scout-17b-16e-instruct",
      )
    : uniqueModels(
        process.env.GROQ_MODERATION_MODEL,
        process.env.GROQ_CHAT_MODEL,
        process.env.GROQ_MODEL,
        "llama-3.3-70b-versatile",
        "llama-3.1-8b-instant",
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

      // Metin ihlalini, modelin gerçekten mesajdaki ifadeyi bulduğunu doğrulayarak uygula.
      // Görsel ihlalinde ise matched görseli tarif eder; metin içinde aranmaz.
      if (category === "cinsel" && imageUrl) {
        return { category, reason: String(parsed.reason ?? "18+ veya cinsel içerikli görsel algılandı.") };
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
  return imageUrl
    ? { category: "gorsel", reason: "Görsel güvenlik kontrolü tamamlanamadığı için görsel engellendi." }
    : fallback;
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
    const subcommand = selectedSubcommand(interaction);
    const subcommandName = String(subcommand?.name ?? "");
    const allowedUsers = getAllowedLinkUsers(guildId);

    if (subcommandName === "durum") {
      const enabled = subcommandOption(subcommand, "durum") === "ac";
      guildLinkPermissions.set(guildId, enabled);
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
    process.env.GROQ_CHAT_MODEL,
    process.env.GROQ_MODEL,
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
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

async function sendAiReply(message: JsonRecord, prompt: string): Promise<void> {
  const answer = await chatWithGroq(message, prompt);
  await sendMessage(String(message.channel_id), {
    content: answer ?? "AI bağlantısı şu an kullanılamıyor. Bot yöneticisi GROQ_API_KEY ve Groq model ayarlarını kontrol etmeli.",
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

function imageAttachments(message: JsonRecord): JsonRecord[] {
  const attachments = Array.isArray(message.attachments)
    ? message.attachments
    : Object.values((message.attachments ?? {}) as Record<string, JsonRecord>);
  return (attachments as JsonRecord[]).filter((attachment) => {
    const contentType = String(attachment.content_type ?? "").toLowerCase();
    const filename = String(attachment.filename ?? "").toLowerCase();
    return contentType.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif)$/i.test(filename);
  });
}

async function handleMessage(message: JsonRecord): Promise<void> {
  if (message.author?.bot) return;
  if (!message.guild_id) {
    await handleAiChat(message);
    return;
  }
  const guildId = String(message.guild_id);
  const authorId = String(message.author?.id ?? "");
  void rememberUser(message);
  const memberPermissions = BigInt(String(message.member?.permissions ?? "0"));
  const isModerator = (memberPermissions & (ADMINISTRATOR | MANAGE_GUILD)) !== 0n;
  const hasLink = LINK_PATTERN.test(String(message.content ?? ""));
  const hasPersonalLinkPermission = guildLinkAllowedUsers.get(guildId)?.has(authorId) ?? false;

  if (hasLink && !guildLinkPermissions.get(guildId) && !hasPersonalLinkPermission && !isModerator) {
    await handleViolation(message, "link", "Bu kullanıcı için link paylaşma izni bulunmadığı için engellendi.");
    return;
  }

  // Moderatörler otomatik cezadan muaftır fakat AI sohbetini kullanmaya devam eder.
  // Normal kullanıcıların botu etiketleyerek küfür/18+ içeriği atlatmasını önlemek
  // için önce moderasyon, sonra AI sohbeti çalışır.
  if (!isModerator) {
    const content = String(message.content ?? "");
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
          void registerCommands(applicationId, String(guild.id)).catch((error) =>
            logger.warn({ err: error }, "Sunucu komutları kaydedilemedi"),
          );
        }
      } else if (eventName === "GUILD_CREATE" && applicationId) {
        void handleGuildCreate(applicationId, data).catch((error) =>
          logger.warn({ err: error }, "Yeni sunucu karşılama işlemi başarısız"),
        );
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
  connectGateway(token);
}