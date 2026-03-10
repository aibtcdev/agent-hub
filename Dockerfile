FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src ./src
COPY tsconfig.json ./

# Data directory for SQLite volume mount
RUN mkdir -p /data

EXPOSE 3100

ENV PORT=3100
ENV DB_PATH=/data/agent-hub.db

CMD ["bun", "run", "src/index.ts"]
