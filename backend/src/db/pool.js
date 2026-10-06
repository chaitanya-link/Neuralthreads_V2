const { Pool } = require('pg');

// Neon (and most managed Postgres) require SSL. `sslmode=require` in your
// DATABASE_URL handles this for you, but we also set it explicitly here so
// local Postgres (no SSL) still works if DATABASE_URL omits it — rejectUnauthorized:
// false is fine for Neon's setup (it uses a trusted CA, this just avoids
// Node's stricter default chain validation tripping on some environments).
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('sslmode=require')
        ? { rejectUnauthorized: false }
        : false,
});

pool.on('error', (err) => {
    // Idle client errors (e.g. Neon closing an idle connection) shouldn't
    // crash the whole server — pg will create a new connection on next use.
    console.error('[db] Unexpected idle client error:', err.message);
});

module.exports = { pool };