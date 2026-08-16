# FrArda Discord Botu — VDS Kurulumu

## Gereksinimler

- Node.js 20 veya daha yeni sürüm
- pnpm 9 veya daha yeni sürüm
- Discord Developer Portal'da oluşturulmuş bot

## Kurulum

```bash
corepack enable
pnpm install --frozen-lockfile
cp artifacts/api-server/.env.example artifacts/api-server/.env
nano artifacts/api-server/.env
```

`.env` dosyasını şu değerlerle doldur:

```env
DISCORD_BOT_TOKEN=Discord_Bot_Token_Buraya
GROQ_API_KEY=Groq_Api_Anahtari_Buraya
GROQ_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
PORT=8080

# İsteğe bağlı: itiraz bildirimlerinin gönderileceği FrArda sahibi
FRARDA_OWNER_ID=
```

Gerçek tokenları GitHub'a veya ZIP dosyasına koyma. Tokenları yalnızca VDS üzerindeki
`.env` dosyasında ya da VDS ortam değişkenlerinde tut.

## Discord izinleri

Developer Portal > Bot bölümünde:

- Message Content Intent
- Server Members Intent

Bot davet izinleri:

- View Channels
- Send Messages
- Manage Messages
- Moderate Members
- Add Reactions
- Embed Links
- Read Message History
- Use Application Commands

## Başlatma

```bash
set -a
source artifacts/api-server/.env
set +a
pnpm --filter @workspace/api-server run dev
```

Bot hazır olduğunda loglarda `FrArda hazır` mesajı görünür.

## Komutlar

### Link izinleri

```text
/link-izni durum durum:Aç
/link-izni durum durum:Kapat
/link-izni ekle kullanici:@Kullanıcı
/link-izni cikar kullanici:@Kullanıcı
/link-izni liste
```

Genel link durumu kapalıyken izin listesinde olmayan üyelerin link mesajları
silinir, üyeye timeout uygulanır ve moderasyon DM'i gönderilir.

### Bilgi komutları

```text
/sunucu-bilgi
/kullanici-bilgi kullanici:@Kullanıcı
```

### Moderasyon itirazı

Timeout uygulanan üyeye DM üzerinden itiraz düğmesi gönderilir. İtiraz FrArda
sahibine iletilir; kabul edilirse timeout kaldırılır, reddedilirse devam eder.

## AI sohbeti

FrArda yalnızca etiketlendiğinde veya kendi mesajına yanıt verildiğinde konuşur.
Groq anahtarı tanımlı değilse AI cevapları çalışmaz.

## Güvenlik

- Gerçek tokenları GitHub'a, ZIP dosyasına veya sohbet mesajlarına koyma.
- Token yanlışlıkla paylaşılırsa Discord Developer Portal'dan hemen yenile.
- VDS'de `.env` dosyasının erişimini sınırla: `chmod 600 artifacts/api-server/.env`