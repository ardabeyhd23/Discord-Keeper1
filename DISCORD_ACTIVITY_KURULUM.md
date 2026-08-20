# FR Family Shop — Discord Activity

Bu sürüm mağazayı Discord'un içine gömülü Activity olarak çalıştırmak için hazırlandı.

## Render Environment
- `DISCORD_CLIENT_ID` = Discord Developer Portal'daki Client ID
- `DISCORD_CLIENT_SECRET` = Client Secret (gizli tut)
- `VITE_DISCORD_CLIENT_ID` = aynı Client ID
- `FR_SHOP_ACTIVITY_ENABLED=true`
- `FR_SHOP_ACTIVITY_URL=https://discord-keeper1.onrender.com`

## Discord Developer Portal
1. Uygulamada **Activities** özelliğini etkinleştir.
2. Activity URL Mapping altında `/` → `discord-keeper1.onrender.com` hedefini ekle.
3. OAuth2 Redirects bölümüne Activity dokümanındaki placeholder `https://127.0.0.1` değerini ekle.
4. Activity'nin desteklediği platformlarda web, iOS ve Android'i aç.
5. User Install + Guild Install bağlamlarını gerektiği gibi etkinleştir.

## Açılış
`/shop` mesajındaki **🛍️ Mağaza Aç** butonu URL'ye gitmek yerine Discord'a `LAUNCH_ACTIVITY` (12) callback'i gönderir. Activities etkin ve URL mapping doğruysa mağaza Discord'un içinde açılır.

## Kullanıcı tanıma
Activity Embedded App SDK üzerinden `identify` + `guilds` yetkisi ister. Sunucu gelen authorization code'u Client Secret ile Discord'a doğrular, `/users/@me` ile gerçek Discord user ID'yi alır ve mağaza session'ına bağlar. Coin/sipariş işlemleri bu server-side session'daki Discord user ID ile yapılır.

`DISCORD_CLIENT_SECRET` frontend'e gönderilmez.
