# FR Family Web Mağaza - düzeltme

Bu sürümde `🛍️ Mağaza Aç` butonu, Discord Embedded/Activity flag'i gerektirmeden doğrudan web mağazasını açar.

Render Environment:
`FR_SHOP_ACTIVITY_URL=https://discord-keeper1.onrender.com`

İsteğe bağlı:
`FR_SHOP_ACTIVITY_ENABLED=false`

Build:
`pnpm install --no-frozen-lockfile && pnpm --filter @workspace/api-server run build`

Start:
`pnpm --filter @workspace/api-server run start`

Not: Discord Activity/Embedded modu ayrıca yapılandırılabilir; bu ZIP web mağazanın güvenilir şekilde açılması için normal URL butonunu kullanır.
