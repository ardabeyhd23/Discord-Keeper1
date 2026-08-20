# Render mağaza düzeltmesi

Bu sürümde `shop-app` pnpm workspace'e dahil edildi. Böylece root `pnpm install`
Vite'ı da kurar ve API build sırasında `vite: not found` hatası oluşmaz.

Render build:
`corepack enable && pnpm install --no-frozen-lockfile && pnpm --filter @workspace/api-server run build`

Start:
`pnpm --filter @workspace/api-server run start`

Mağaza aynı bot servisi üzerinden `/shop` adresinden yayınlanır.
