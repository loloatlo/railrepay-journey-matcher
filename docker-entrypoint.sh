#!/bin/sh
# Docker entrypoint for journey-matcher service
# Creates schema and runs migrations before starting the service

set -e

echo "Creating journey_matcher schema via Node.js..."
# Create schema using Node.js and pg library before migrations
node -e "
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL });
client.connect()
  .then(() => client.query('CREATE SCHEMA IF NOT EXISTS journey_matcher'))
  .then(() => {
    console.log('Schema journey_matcher created or already exists');
    return client.end();
  })
  .catch(err => {
    console.error('Schema creation error:', err.message);
    process.exit(1);
  });
"

echo "Running database migrations..."
npm run migrate:up

echo "Starting journey-matcher service..."
exec npm start
