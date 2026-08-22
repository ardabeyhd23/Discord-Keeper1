# Render

Build Command:
`pnpm install --no-frozen-lockfile && pnpm --filter @workspace/api-server run build`

Start Command:
`pnpm --filter @workspace/api-server run start`

Not: Render ortamında `/usr/bin` read-only olduğu için `corepack enable` kullanılmaz.
