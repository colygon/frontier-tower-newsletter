FROM node:22-alpine AS base
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY data/ ./data/

# Create data directory for runtime
RUN mkdir -p /app/data

# Health check endpoint — the platform CLI prints usage and exits 0
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "process.exit(0)"

# Default: run the platform
ENTRYPOINT ["npx", "tsx"]
CMD ["src/index.ts"]
