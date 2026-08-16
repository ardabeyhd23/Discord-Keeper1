# FrArda Discord Botu — VDS Kurulumu

## 1. Gereksinimler

- Node.js 20 veya daha yeni sürüm
- pnpm 9 veya daha yeni sürüm
- Discord Developer Portal'da oluşturulmuş bot

## 2. Kurulum

```bash
corepack enable
pnpm install --frozen-lockfile
cp artifacts/api-server/.env.example artifacts/api-server/.env
nano artifacts/api-server/.env
```

`.env` dosyasına gerçek değerleri yaz:

```env
DISCORD_BOT_TOKEN=Discord_Bot_Token_Buraya
GROQ_API_KEY=Groq_Api_Anahtari_Buraya
GROQ_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
PORT=8080

# İsteğe bağlı: kullanıcı kimlikleriyle kesin etiketleme
FRARDA_USER_ID=
FRBOSSZZZ_USER_ID=
```

## 3. Discord izinleri

Developer Portal > Bot bölümünde şunları aç:

- Message Content Intent
- Server Members Intent

Botu şu izinlerle davet et:

- View Channels
- Send Messages
- Manage Messages
- Moderate Members
- Add Reactions
- Embed Links
- Read Message History
- Use Application Commands

## 4. Başlatma

```bash
export $(grep -v '^#' artifacts/api-server/.env | xargs)
pnpm --filter @workspace/api-server run dev
```

Bot hazır olduğunda loglarda `FrArda hazır` mesajı görünür.

## 5. Komutlar

```text
/link-izni durum:Aç
/link-izni durum:Kapat
/frbosszzz eylem:Başlat kapsam:Bu kanal
/frbosszzz eylem:Başlat kapsam:Tüm sunucu
/frbosszzz eylem:Durdur
```

## Güvenlik

- Gerçek tokenları GitHub'a, ZIP dosyasına veya sohbet mesajına koyma.
- `.env` dosyasını Git'e ekleme.
- Token yanlışlıkla paylaşılırsa Discord Developer Portal'dan hemen yenile.