/**
 * Minimal migration runner — no framework, just a tracked list of .sql files
 * applied in filename order. Good enough for a solo-dev MVP; revisit with a
 * real tool (node-pg-migrate, Prisma Migrate) if the schema grows a lot.
 *
 * Usage: npm run migrate
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');

async function run() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS _migrations (
                filename TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `);

        const dir = path.join(__dirname, '..', '..', 'migrations');
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

        for (const file of files) {
            const { rows } = await client.query('SELECT 1 FROM _migrations WHERE filename = $1', [file]);
            if (rows.length > 0) {
                console.log(`[migrate] Skipping ${file} (already applied)`);
                continue;
            }
            console.log(`[migrate] Applying ${file}...`);
            const sql = fs.readFileSync(path.join(dir, file), 'utf8');
            await client.query('BEGIN');
            try {
                await client.query(sql);
                await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
                await client.query('COMMIT');
                console.log(`[migrate] ✓ ${file}`);
            } catch (err) {
                await client.query('ROLLBACK');
                throw new Error(`Migration ${file} failed: ${err.message}`);
            }
        }
        console.log('[migrate] Done.');
    } finally {
        client.release();
        await pool.end();
    }
}

run().catch((err) => {
    console.error('[migrate] Fatal:', err.message);
    process.exit(1);
});