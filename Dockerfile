# Multi-stage Dockerfile for journey-matcher service
# Per RailRepay DevOps standards and Railway deployment requirements

# Stage 1: Build dependencies
FROM node:20-alpine AS deps
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Stage 2: Build TypeScript
FROM node:20-alpine AS builder
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Type check (fail fast if types are wrong)
RUN npm run typecheck

# Stage 3: Production runtime
FROM node:20-alpine AS runner
WORKDIR /app

# Install production dependencies for ts-node/esm loader
# Required for ESM execution: "start": "node --loader ts-node/esm src/index.ts"
COPY package*.json ./
RUN npm ci --only=production && \
    npm install ts-node && \
    npm cache clean --force

# Copy application code
COPY --from=builder /app/src ./src
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/run-migrations-manual.js ./

# Copy entrypoint script
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# Health check (ADR-008)
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:${PORT:-3000}/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); })"

# Expose port (Railway will override with PORT env var)
EXPOSE 3000

# Start the service with entrypoint that runs migrations
ENTRYPOINT ["./docker-entrypoint.sh"]
