# FrArda Discord Bot

FrArda, Discord sunucularında moderasyon, kurallar bilgisi, hoş geldin DM'i ve
Türkçe yapay zekâ sohbeti sağlayan bir sunucu asistanıdır.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/bot.ts` — Discord Gateway, moderasyon, slash komutları,
  rules/kural kanalı okuma, yeni üye DM'i ve AI sohbeti.
- `artifacts/api-server/.env.example` — Discord, Groq ve hoş geldin DM ayarları.
- `FRARDA-VDS-KURULUM.md` — Discord Developer Portal ve VDS/Render kurulum notları.

## Architecture decisions
- Kurallar bağlamı yalnızca Discord'un `rules_channel_id` alanından veya adı
  `rules`, `rule`, `kural`, `kurallar` olan kanallardan okunur; genel bilgi ve
  duyuru kanalları otomatik kural kaynağı değildir.
- Kurallar içeriği API çağrılarını azaltmak için kısa süreli bellekte önbelleğe alınır.
- Sunucu kanalında AI yalnızca etiket veya bot mesajına yanıt ile çalışır; DM'de
  kullanıcı doğrudan yazdığında çalışır.

## Product
- Link paylaşımı izinleri ve otomatik moderasyon
- `/sunucu-bilgi`, `/kullanici-bilgi` ve `/öneri` komutları
- İtiraz ve kural sınaması akışı
- Yeni üyeye otomatik hoş geldin DM'i
- Sunucu ve DM içinde Groq tabanlı Türkçe AI sohbeti
- FrArda sahibinin onay/red düğmeleriyle gelişmiş öneri sistemi

## User preferences
- Türkçe kullanıcı deneyimi ve Discord içi kullanım öncelikli.

## Gotchas
- Discord Developer Portal'da `Guild Members`, `Guild Messages`,
  `Message Content` ve `Direct Messages` için gerekli intent/izinler açık olmalı.
- Yeni üye DM'i ve AI sohbeti için `DISCORD_BOT_TOKEN` ile `GROQ_API_KEY`
  çalışma ortamında tanımlı olmalı; DM'leri kapalı üyelerde hoş geldin mesajı
  Discord tarafından engellenebilir.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
