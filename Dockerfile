FROM node:20-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev


FROM node:20-alpine

# docker-cli-compose lets Vigil update itself via `docker compose pull && up -d`
RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app

ARG VIGIL_VERSION=dev
ENV VIGIL_VERSION=$VIGIL_VERSION \
    NODE_ENV=production

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /app/logs
VOLUME ["/app/logs"]

LABEL org.opencontainers.image.source="https://github.com/VigilOpsHq/vigil" \
      org.opencontainers.image.title="Vigil" \
      org.opencontainers.image.description="Self-hosted AI DevOps agent for your VPS" \
      org.opencontainers.image.licenses="MIT"

CMD ["node", "dist/index.js"]
