#!/bin/sh
# Docker entrypoint for journey-matcher service
# Runs database migrations before starting the service

set -e

echo "Running database migrations..."
npm run migrate:up

echo "Starting journey-matcher service..."
exec npm start
