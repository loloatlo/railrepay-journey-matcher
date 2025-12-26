/**
 * Manual migration runner for journey-matcher
 * Bypasses node-pg-migrate due to phantom migration conflict
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function runMigrations() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();
    console.log('Connected to database');

    // Create migration tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.journey_matcher_migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        run_on TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('Migration tracking table ready');

    // Get list of completed migrations
    const { rows } = await client.query('SELECT name FROM public.journey_matcher_migrations');
    const completedMigrations = new Set(rows.map(r => r.name));

    // Read and execute migration files in order
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.cjs'))
      .sort();

    for (const file of files) {
      const migrationName = file.replace('.cjs', '');

      if (completedMigrations.has(migrationName)) {
        console.log(`✓ Skipping ${migrationName} (already run)`);
        continue;
      }

      console.log(`Running ${migrationName}...`);
      const migration = require(path.join(migrationsDir, file));

      // Execute the up migration
      const pgm = createPgm(client);
      await migration.up(pgm);
      await pgm.flush();

      // Record migration
      await client.query(
        'INSERT INTO public.journey_matcher_migrations (name) VALUES ($1)',
        [migrationName]
      );
      console.log(`✓ Completed ${migrationName}`);
    }

    console.log('All migrations completed successfully');
    await client.end();
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    await client.end();
    process.exit(1);
  }
}

// Minimal pgm interface implementation
function createPgm(client) {
  const operations = [];

  return {
    createSchema: (schemaName, options = {}) => {
      operations.push(async () => {
        const ifNotExists = options.ifNotExists ? 'IF NOT EXISTS' : '';
        await client.query(`CREATE SCHEMA ${ifNotExists} ${schemaName}`);
      });
    },

    createTable: (tableName, columns, options = {}) => {
      operations.push(async () => {
        const ifNotExists = options.ifNotExists ? 'IF NOT EXISTS' : '';
        const columnDefs = Object.entries(columns).map(([name, def]) => {
          return `${name} ${formatColumnDef(def)}`;
        }).join(', ');

        await client.query(`CREATE TABLE ${ifNotExists} ${tableName} (${columnDefs})`);
      });
    },

    sql: (query) => {
      operations.push(async () => {
        await client.query(query);
      });
    },

    func: (functionCall) => {
      // Return a marker object that formatColumnDef will recognize
      return { __pgmFunc: functionCall };
    },

    flush: async () => {
      for (const op of operations) {
        await op();
      }
      operations.length = 0;
    }
  };
}

function formatColumnDef(def) {
  // Basic column definition formatting
  if (typeof def === 'string') return def;

  let sql = def.type || '';
  if (def.notNull) sql += ' NOT NULL';
  if (def.primaryKey) sql += ' PRIMARY KEY';
  if (def.unique) sql += ' UNIQUE';
  if (def.default !== undefined) {
    // Handle pgm.func() calls
    if (def.default && typeof def.default === 'object' && def.default.__pgmFunc) {
      sql += ` DEFAULT ${def.default.__pgmFunc}`;
    } else {
      sql += ` DEFAULT ${def.default}`;
    }
  }
  if (def.references) sql += ` REFERENCES ${def.references}`;
  if (def.comment) {
    // Comments are handled separately in PostgreSQL, skip for now
  }

  return sql;
}

runMigrations();
