# syntax=docker/dockerfile:1

FROM node:20.20.0-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20.20.0-alpine
WORKDIR /app
# tzdata so the TZ env (America/New_York) resolves — Alpine ships none, and
# without it Node's Date.getHours() falls back to UTC and the comfort engine's
# sleep window triggers ~4h early.
RUN apk add --no-cache tzdata
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
ENV NODE_ENV=production
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3000}/health/live || exit 1
CMD ["node", "dist/index.js"]
