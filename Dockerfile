FROM oven/bun:1-alpine AS builder

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN bun build src/index.ts --target=bun --outdir=dist --minify

# ---

FROM oven/bun:1-alpine

WORKDIR /app

# curl is only used by the HEALTHCHECK below.
RUN apk add --no-cache curl

# Copy artifacts as the non-root `bun` user (uid 1000) that ships with the
# upstream image. Running as root would let a process escape into the rest of
# the filesystem if it ever found an arbitrary-write bug.
COPY --from=builder --chown=bun:bun /app/dist ./dist
COPY --from=builder --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/package.json ./

USER bun

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:8080/ || exit 1

CMD ["bun", "run", "dist/index.js"]
