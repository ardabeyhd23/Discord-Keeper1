# FR Family Shop + Discord-Keeper1

Bu sürüm mağazayı ayrı Render servisi olarak değil, mevcut Discord-Keeper1 API sunucusunun
aynı URL'si üzerinden yayınlar.

## Mevcut Discord-Keeper1 servisini kullan

Render'da YENİ bot oluşturma.

Mevcut Discord-Keeper1 servisinin Build Command'ı:
`pnpm install --no-frozen-lockfile && cd artifacts/api-server && pnpm run build`

Start Command:
`pnpm --filter @workspace/api-server run start`

Bu build sırasında `shop-app` ayrıca derlenir ve `public/shop` içine kopyalanır.

## Environment

`FR_SHOP_ACTIVITY_URL=https://DISCORD-KEEPER1-ADRESIN.onrender.com`

`FR_SHOP_OAUTH_REDIRECT_URI=https://DISCORD-KEEPER1-ADRESIN.onrender.com/api/shop/auth/callback`

`FR_SHOP_GUILD_ID=SUNUCU_ID`

`DISCORD_CLIENT_ID=...`
`DISCORD_CLIENT_SECRET=...`

Web mağaza aynı bot adresinde açılır:
`https://DISCORD-KEEPER1-ADRESIN.onrender.com/`

Web tarafında VITE_API_BASE_URL vermek zorunlu değildir; API aynı origin'dedir.
