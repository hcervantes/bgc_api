# bgc-api — NestJS + Prisma 6, port 4000
# Build:  docker build -t registry.digitalocean.com/bgc-registry/api:<tag> .
# Run:    runtime secrets come from the droplet compose env_file (.env),
#         never baked into the image (Stripe keys, ERPNext creds, DB URL).

# Stage 1: build
FROM node:22-alpine AS build
WORKDIR /app
# Prisma 6 query engine needs openssl on alpine
RUN apk add --no-cache openssl
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# prisma generate BEFORE nest build so the generated client is present.
# rm the tsbuildinfo FIRST: nest-cli deletes dist/ (deleteOutDir), but tsc's
# incremental state (tsconfig.tsbuildinfo, copied in via the context if not
# dockerignored) then claims everything is up-to-date and emits NOTHING —
# a "successful" build with an empty dist/ (seen live Oct 30, 2026).
RUN rm -f tsconfig.tsbuildinfo && npx prisma generate && npm run build

# Stage 2: serve
FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache openssl wget
ENV NODE_ENV=production PORT=4000
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
USER node
EXPOSE 4000
# GET /v1/health is @Public() — exercises HTTP + the express stack end-to-end
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:4000/v1/health || exit 1
CMD ["node", "dist/main.js"]
