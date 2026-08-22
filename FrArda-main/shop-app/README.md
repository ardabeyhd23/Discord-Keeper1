# FR Family Shop • Modern Discord Web Shop

Bu web mağazası, Discord'daki `/shop` komutunun gönderdiği **🛍️ Mağaza Aç** butonundan açılır ve gerçek FR Family Shop state'ine bağlanır.

## Gerçek sistem bağlantısı

Web tarafı artık demo coin/katalog kullanmak yerine bot API'sine bağlanır:

- `GET /api/shop/catalog` → Discord OAuth ile giriş yapan kullanıcının gerçek coin bakiyesi ve mevcut mağaza ürünleri.
- `POST /api/shop/purchase` → gerçek coin düşümü + mevcut `createShopOrder()` sipariş sistemi.

Web siparişi oluşturulduğunda mevcut bot akışı korunur: yönetici DM'i, `#sipariş-aktivasyonu` bildirimi ve mevcut `/siparis-tamamla` sistemi çalışmaya devam eder. Sipariş reddedilirse mevcut bot kodu coin iadesini yapar.

## Web kurulumu

```bash
pnpm install --ignore-workspace
cp .env.example .env
pnpm run build
```

Web deploy adresini aldıktan sonra:

```env
VITE_API_BASE_URL=https://BOT-ADRESINIZ.com
```

`VITE_API_BASE_URL` build sırasında web uygulamasına gömülür.

## Bot ortam değişkenleri

```env
FR_SHOP_ACTIVITY_URL=https://MAGAZA-ADRESINIZ.com
DISCORD_CLIENT_ID=1535760848407232603
DISCORD_CLIENT_SECRET=DISCORD_APPLICATION_SECRET
FR_SHOP_OAUTH_REDIRECT_URI=https://BOT-ADRESINIZ.com/api/shop/auth/callback
```

İstersen mağazayı tek bir Discord sunucusuna sabitlemek için:

```env
FR_SHOP_GUILD_ID=SUNUCU_ID
```

## Discord Developer Portal

Discord uygulamanın OAuth2 ayarlarına şu redirect URI'yi ekle:

```text
https://BOT-ADRESINIZ.com/api/shop/auth/callback
```

OAuth scope olarak `identify` ve `guilds` kullanılıyor.

## Akış

1. Kullanıcı Discord'da `/shop` yazar.
2. Bot `#mağaza` kanalına **🛍️ Mağaza Aç** butonunu gönderir.
3. Kullanıcı butona basar ve web mağazasına gider.
4. Kullanıcı Discord hesabıyla yetkilendirilir.
5. API, kullanıcının botun bulunduğu sunucusunu belirler.
6. Web gerçek katalog ve coin bakiyesini gösterir.
7. Satın alma isteği botun mevcut shop state'ine gider.
8. Coin düşer ve mevcut sipariş sistemi çalışır.
9. Yönetici mevcut Discord butonlarıyla siparişi tamamlar/reddeder.

## Not

Web oturumları API belleğinde tutulur ve 24 saat geçerlidir. Bot/API yeniden başlatılırsa kullanıcı tekrar Discord ile giriş yapabilir. Gerçek para/coin işlemlerinde API'yi yalnızca HTTPS üzerinden yayınla.

## Robux ürünleri

Katalogda gerçek sipariş akışına bağlı Robux ürünleri bulunur:

- 100 Robux — 10.000 Coin
- 500 Robux — 40.000 Coin
- 1.000 Robux — 75.000 Coin
- 2.500 Robux — 150.000 Coin

Robux teslimatı bot tarafından otomatik yapılmaz; sipariş mevcut yönetici onay akışına gider. Ürün ikonları native cihaz emojisi yerine CSS ile çizilen özel ikonlardır.
