require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./src/routes/auth');
const sessionsRoutes = require('./src/routes/sessions');

const app = express();

// CORS: the extension calls this from a chrome-extension:// origin, and the
// dashboard calls it from your Vercel domain. ALLOWED_ORIGINS is a
// comma-separated list in .env so you don't have to redeploy to add one.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

app.use(cors({
    origin(origin, callback) {
        // No Origin header (curl, server-to-server, some extension contexts) — allow.
        if (!origin) return callback(null, true);
        if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error(`Origin ${origin} not allowed by CORS. Add it to ALLOWED_ORIGINS in .env`));
    },
    credentials: true,
}));

app.use(express.json({ limit: '20mb' })); // attachments ride along as base64 in the session create payload

app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/sessions', sessionsRoutes);

// Last-resort error handler — CORS rejection and any uncaught route error
// land here instead of a raw stack trace reaching the client.
app.use((err, _req, res, _next) => {
    console.error('[server] Unhandled error:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`[server] NeuralThreads API listening on :${PORT}`);
});