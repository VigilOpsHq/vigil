FROM node:20-alpine

RUN apk add --no-cache docker-cli

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

RUN mkdir -p /app/logs

VOLUME ["/app/logs"]

CMD ["node", "dist/index.js"]
