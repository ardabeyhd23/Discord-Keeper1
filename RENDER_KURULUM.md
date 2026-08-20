# FR Family Shop - Render

## Render Web Service

Build Command:
`pnpm install --frozen-lockfile && pnpm --filter @workspace/shop-app run build`

Start Command:
`pnpm --filter @workspace/shop-app run start`

Environment variable:
`VITE_API_BASE_URL=https://YOUR-BOT-RENDER-URL`

If the shop is intended to be a Static Site instead, use the generated `dist` directory from the shop app after confirming its package scripts.
