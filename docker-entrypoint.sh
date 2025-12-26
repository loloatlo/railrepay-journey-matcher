#!/bin/sh
# Docker entrypoint for journey-matcher service
# Creates schema and tables before starting the service

set -e

echo "Initializing journey-matcher database schema..."
node -e "
const { Client } = require('pg');
const fs = require('fs');
const client = new Client({ connectionString: process.env.DATABASE_URL });

client.connect()
  .then(() => client.query('CREATE SCHEMA IF NOT EXISTS journey_matcher'))
  .then(() => {
    console.log('✓ Schema created');
    const sql = fs.readFileSync('init-schema.sql', 'utf8');
    return client.query(sql);
  })
  .then(() => {
    console.log('✓ Tables created');
    return client.end();
  })
  .then(() => {
    console.log('✓ Database initialization complete');
  })
  .catch(err => {
    console.error('Database initialization error:', err.message);
    process.exit(1);
  });
"

echo "Starting journey-matcher service..."
exec npm start
