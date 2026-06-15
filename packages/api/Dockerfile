# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace manifests + lockfile
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/api/package.json ./packages/api/

# Install all workspace deps
RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
COPY packages/api/ ./packages/api/
COPY coords.csv ./coords.csv

# Generate Prisma client + build
RUN pnpm --filter @st/api prisma:generate
RUN pnpm --filter @st/shared build
RUN pnpm --filter @st/api build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Prisma's schema/migration engine needs OpenSSL at runtime; node:20-alpine ships without it,
# so `migrate deploy` fails with "Could not parse schema engine response". (Wave-5 fix; DRIFT #34)
RUN apk add --no-cache openssl

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/api/package.json ./packages/api/

# Full install (NOT --prod): the runtime CMD runs `prisma migrate deploy`, and the `prisma`
# CLI is a devDependency — a --prod install omits it, leaving `node_modules/.bin/prisma`
# missing so the container crash-loops before the server ever starts. (Wave-5 fix; DRIFT #34)
RUN pnpm install --frozen-lockfile

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/api/dist ./packages/api/dist
COPY --from=builder /app/packages/api/prisma ./packages/api/prisma
COPY --from=builder /app/coords.csv ./coords.csv

EXPOSE 3000

# Run migrations then start the server. In a pnpm workspace the `prisma` CLI bin is installed
# under the OWNING package (packages/api/node_modules/.bin), not the workspace root — the old
# root-relative path crash-looped with "node_modules/.bin/prisma: not found". (Wave-5 fix; DRIFT #34)
CMD ["sh", "-c", "packages/api/node_modules/.bin/prisma migrate deploy --schema packages/api/prisma/schema.prisma && node packages/api/dist/server.js"]
