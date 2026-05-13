FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm ci --only=production

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm install typescript ts-node --save-dev && npm run build

# Runtime
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY --from=0 /app/dist ./dist

# Create logs volume mount point
RUN mkdir -p /app/logs

VOLUME ["/app/logs"]

CMD ["node", "dist/index.js"]
