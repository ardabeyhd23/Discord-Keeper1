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

## Render.com kurulumu

Bu proje Render üzerinde **Web Service** olarak çalışır. Proje kökündeki
`render.yaml` dosyası build, start ve health check ayarlarını içerir.

1. ZIP'i GitHub'a yükle.
2. Render'da **New > Blueprint** seçip GitHub deposunu bağla.
3. Render'ın oluşturduğu serviste şu gizli değişkenleri ekle:
   - `DISCORD_BOT_TOKEN`
   - `GROQ_API_KEY`
   - İsteğe bağlı: `FRARDA_OWNER_ID`
4. Deploy tamamlandığında loglarda `FrArda hazır` mesajını kontrol et.

Render'ın ücretsiz servisleri boşta kalırsa uykuya geçebilir. Botun kesintisiz
çalışması gerekiyorsa uykuya geçmeyen bir Render planı kullan.

## Discord Developer Portal izinleri

Botun mesajları okuyup silebilmesi, üyeyi susturabilmesi ve DM gönderebilmesi
için bot rolünde en az şu izinler açık olmalı:

- View Channels
- Send Messages
- Embed Links
- Read Message History
- Manage Messages
- Moderate Members

Discord Developer Portal > Bot bölümünde **Message Content Intent** seçeneğini
de aç. Bu kapalı kalırsa bot mesaj metnini boş alır; küfür, argo ve AI
etiketlerini göremez. Bot rolünü sunucuda susturulacak üyelerin rollerinin
üstüne taşı; aksi halde Discord timeout isteğini reddeder. DM'leri kapalı olan
kullanıcılara Discord izin vermediği için DM gönderilemez, ancak mesaj yine
silinir ve timeout uygulanır.

## Moderasyon davranışı

- Küfür, argo, tehdit ve 18+ metinler silinir, timeout uygulanır ve kullanıcıya
  moderasyon DM'i gönderilir.
- Görsel ekleri Groq görsel modeliyle kontrol edilir; çıplaklık, cinsel eylem
  veya açıkça 18+ içerik görülürse mesajın tamamı silinir, timeout uygulanır ve
  DM gönderilir.
- Görsel güvenlik modeli yanıt veremezse bot güvenli tarafta kalıp görseli
  geçici olarak engeller.
- Bot etiketlenen mesajı önce moderasyondan geçirir. İhlal varsa AI cevabı
  göndermez; temizse normal AI yanıtı verir.

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