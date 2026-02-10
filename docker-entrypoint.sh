#!/bin/sh
# Docker entrypoint for journey-matcher service
# Creates schema and tables before starting the service

set -e

echo "Initializing journey-matcher database schema..."

# Use ESM-compatible syntax with --input-type=module
node --input-type=module -e "
import pg from 'pg';
import fs from 'fs';

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  await client.query('CREATE SCHEMA IF NOT EXISTS journey_matcher');
  console.log('✓ Schema created');

  const sql = fs.readFileSync('init-schema.sql', 'utf8');
  await client.query(sql);
  console.log('✓ Tables created');

  await client.end();
  console.log('✓ Database initialization complete');
} catch (err) {
  console.error('Database initialization error:', err.message);
  process.exit(1);
}
"

echo "Running database migrations..."
npx node-pg-migrate up -f database.json || echo "Migrations may have already been applied"

echo "Starting journey-matcher service..."
exec npm start
