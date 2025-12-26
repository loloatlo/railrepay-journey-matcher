#!/bin/sh
# Docker entrypoint for journey-matcher service
# Runs database migrations before starting the service

set -e

echo "=== Debug: Listing migration files ==="
ls -la /app/migrations/
echo "=== Debug: Contents of .node-pg-migrate.json ==="
cat /app/.node-pg-migrate.json
echo "=== End Debug ==="

echo "Running database migrations..."
npm run migrate:up

echo "Starting journey-matcher service..."
exec npm start
