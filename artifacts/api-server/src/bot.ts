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
  responseTimer?: ReturnType<typeof setTimeout>;
}

interface WishLoop {
  channelId: string;
  scope: "kanal" | "sunucu";
  messageIndex: number;
  timer: ReturnType<typeof setInterval>;
}

const guildLinkPermissions = new Map<string, boolean>();
const moderationCases = new Map<string, ModerationCase>();
const wishLoops = new Map<string, WishLoop>();
const heartedMessages = new Set<string>();
const registeredCommandGuilds = new Set<string>();
const frArdaCache = new Map<
  string,
  { member: JsonRecord | null; expiresAt: number }
>();

const wishMessages = [
  "FrArda ve frbosszzz için bugün de sağlık, huzur ve başarı diliyoruz.",
  "Fr Family’nin geleceği aydınlık olsun; FrArda ve frbosszzz hep mutlu olsun.",
  "İyi dileklerimiz FrArda’dan frbosszzz’a, oradan tüm Fr Family’ye ulaşsın.",
  "FrArda ve frbosszzz’ın yolu güzel insanlarla, güzel haberlerle kesişsin.",
  "Fr Family’ye bereket, neşe ve dayanışma dolu bir gelecek diliyoruz.",
  "FrArda ve frbosszzz için her yeni gün yeni bir başarı getirsin.",
  "Kalplerimiz Fr Family ile; huzur ve mutluluk hepinizin yanında olsun.",
  "FrArda ve frbosszzz’ın emekleri karşılığını bulsun, dilekleri gerçek olsun.",
  "Bugünün iyi dileği: Fr Family’de sevgi, saygı ve kardeşlik hiç eksilmesin.",
  "Sonsuz iyi dileklerle: FrArda, frbosszzz ve tüm Fr Family için güzel yarınlara.",
];

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

function fallbackClassification(text: string): {
  category: "clean" | "argo" | "kufur" | "kavga";
  reason: string;
} {
  const normalized = text.toLocaleLowerCase("tr-TR");
  const profanity = [
    "amk",
    "aq",
    "sik",
    "oç",
    "orospu",
    "piç",
    "yarrak",
    "ibne",
    "gerizekalı",
  ];
  const slang = ["salak", "aptal", "mal", "lan", "ulan", "ezik"];
  const fight = [
    "döv",
    "kavga",
    "saldır",
    "öldür",
    "tehdit",
    "vuracağım",
    "dayak",
  ];
  if (fight.some((word) => normalized.includes(word))) {
    return { category: "kavga", reason: "Kavga veya tehdit ifadesi algılandı." };
  }
  if (profanity.some((word) => normalized.includes(word))) {
    return { category: "kufur", reason: "Küfür veya ağır hakaret algılandı." };
  }
  if (slang.some((word) => normalized.includes(word))) {
    return { category: "argo", reason: "Argo veya hafif hakaret algılandı." };
  }
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

async function findFrArda(guildId: string): Promise<JsonRecord | null> {
  const configuredId = process.env.FRARDA_USER_ID;
  if (configuredId) {
    return { user: { id: configuredId, username: "FrArda" } };
  }
  const cached = frArdaCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached.member;
  const members = (await discordApi(
    `/guilds/${guildId}/members/search?query=FrArda&limit=10`,
  )) as JsonRecord[];
  const member =
    members.find((member) => {
      const user = member.user ?? {};
      return [user.username, user.global_name, member.nick]
        .filter(Boolean)
        .some((name) => String(name).toLocaleLowerCase("tr-TR") === "frarda");
    }) ?? null;
  frArdaCache.set(guildId, { member, expiresAt: Date.now() + 10 * 60_000 });
  return member;
}

async function notifyFrArda(caseData: ModerationCase): Promise<void> {
  const frArda = await findFrArda(caseData.guildId);
  if (!frArda?.user?.id) {
    logger.warn({ guildId: caseData.guildId }, "FrArda Discord üyesi bulunamadı");
    return;
  }
  caseData.frArdaUserId = String(frArda.user.id);
  const channelId = await createDirectMessage(caseData.frArdaUserId);
  await sendMessage(channelId, {
    content: `FrArda, ${caseData.userId} kullanıcısının itirazı var. ${durationLabel(caseData.durationMs)} susturma işlemini kabul ediyor musun?`,
    embeds: [
      {
        title: "FrArda moderasyon bildirimi",
        description: `Kategori: **${caseData.category}**\nGerekçe: ${caseData.reason}\nVaka: \`${caseData.id}\``,
        color: 0xeab308,
      },
    ],
    components: [
      row(
        button(`appeal_accept:${caseData.id}`, "İtirazı kabul et", 3),
        button(`appeal_reject:${caseData.id}`, "Reddet", 4),
      ),
    ],
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
      {
        name: "frbosszzz",
        description: "FrArda ve frbosszzz için iyi dilek döngüsünü yönetir.",
        type: 1,
        options: [
          {
            name: "eylem",
            description: "Döngüyü başlat veya durdur",
            type: 3,
            required: true,
            choices: [
              { name: "Başlat", value: "baslat" },
              { name: "Durdur", value: "durdur" },
            ],
          },
          {
            name: "kapsam",
            description: "Dileklerin kapsamı",
            type: 3,
            required: false,
            choices: [
              { name: "Bu kanal", value: "kanal" },
              { name: "Tüm sunucu", value: "sunucu" },
            ],
          },
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

async function wishMessage(guildId: string, loop: WishLoop): Promise<void> {
  const frArda = await findFrArda(guildId);
  const wish = wishMessages[loop.messageIndex % wishMessages.length];
  loop.messageIndex = (loop.messageIndex + 1) % wishMessages.length;
  const tags: string[] = [];
  let content: string;
  if (loop.scope === "kanal") {
    const frArdaMention = frArda?.user?.id ? `<@${frArda.user.id}>` : "FrArda";
    const frBossMention = process.env.FRBOSSZZZ_USER_ID
      ? `<@${process.env.FRBOSSZZZ_USER_ID}>`
      : "frbosszzz";
    content = `${frArdaMention} ve ${frBossMention}: ${wish}`;
    if (frArda?.user?.id) tags.push(String(frArda.user.id));
    if (process.env.FRBOSSZZZ_USER_ID) tags.push(process.env.FRBOSSZZZ_USER_ID);
  } else {
    content = wish;
  }
  await sendMessage(loop.channelId, {
    content,
    allowed_mentions: { users: tags },
  });
}

async function handleSlashCommand(interaction: JsonRecord): Promise<void> {
  const command = String(interaction.data?.name ?? "");
  const guildId = String(interaction.guild_id ?? "");
  if (!guildId) {
    await interactionReply(interaction, "Bu komutlar yalnızca sunucularda kullanılabilir.", [], true);
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

  if (command === "frbosszzz") {
    const action = optionValue(interaction, "eylem");
    if (action === "durdur") {
      const current = wishLoops.get(guildId);
      if (!current) {
        await interactionReply(interaction, "Bu sunucuda çalışan bir iyi dilek döngüsü yok.", [], true);
        return;
      }
      clearInterval(current.timer);
      wishLoops.delete(guildId);
      await interactionReply(interaction, "İyi dilek döngüsü durduruldu.");
      return;
    }
    if (wishLoops.has(guildId)) {
      await interactionReply(interaction, "Bu sunucuda zaten çalışan bir döngü var.", [], true);
      return;
    }
    const scope = (optionValue(interaction, "kapsam") ?? "kanal") as "kanal" | "sunucu";
    const loop: WishLoop = {
      channelId: String(interaction.channel_id),
      scope,
      messageIndex: 0,
      timer: setInterval(() => {
        void wishMessage(guildId, loop).catch((error) =>
          logger.warn({ err: error, guildId }, "İyi dilek mesajı gönderilemedi"),
        );
      }, 5_000),
    };
    wishLoops.set(guildId, loop);
    await wishMessage(guildId, loop);
    await interactionReply(
      interaction,
      scope === "kanal"
        ? "İyi dilek döngüsü bu kanalda başlatıldı. Durdurmak için `/frbosszzz eylem:durdur` kullan."
        : "Etiketsiz Fr Family iyi dilek döngüsü tüm sunucu için başlatıldı. Durdurmak için `/frbosszzz eylem:durdur` kullan.",
    );
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
    if (String(interaction.user?.id) !== caseData.userId) {
      await interactionReply(interaction, "Bu itiraz düğmesi yalnızca ilgili üyeye ait.", [], true);
      return;
    }
    if (caseData.appealRequested) {
      await interactionReply(interaction, "İtirazın zaten FrArda’ya iletildi. Yanıt bekleniyor.", [], true);
      return;
    }
    caseData.appealRequested = true;
    await interactionReply(interaction, "İtirazın FrArda’ya iletiliyor. Yanıt bekleniyor.", [], true);
    await notifyFrArda(caseData);
    caseData.responseTimer = setTimeout(() => {
      void startChallenge(caseData).catch((error) =>
        logger.warn({ err: error, caseId: caseData.id }, "Kural sınaması başlatılamadı"),
      );
    }, 5 * 60_000);
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
    } else if (interaction.type === 3) {
      await handleComponent(interaction);
    }
  } catch (error) {
    logger.error({ err: error }, "Discord etkileşimi işlenemedi");
  }
}

async function handleMessage(message: JsonRecord): Promise<void> {
  if (!message.guild_id || message.author?.bot) return;
  const guildId = String(message.guild_id);
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