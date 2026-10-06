const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db/pool');
const { signAccessToken, generateRefreshToken, hashToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(row) {
    return { id: row.id, email: row.email, createdAt: row.created_at };
}

router.post('/signup', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !EMAIL_RX.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const client = await pool.connect();
    try {
        const existing = await client.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
        if (existing.rows.length > 0) return res.status(409).json({ error: 'An account with that email already exists.' });

        const passwordHash = await bcrypt.hash(password, 12);
        const { rows } = await client.query(
            'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at',
            [email.toLowerCase(), passwordHash]
        );
        const user = rows[0];

        const accessToken = signAccessToken(user.id);
        const { token: refreshToken, tokenHash, expiresAt } = generateRefreshToken();
        await client.query(
            'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
            [user.id, tokenHash, expiresAt]
        );

        res.status(201).json({ user: publicUser(user), accessToken, refreshToken });
    } catch (err) {
        console.error('[auth/signup] error:', err.message);
        res.status(500).json({ error: 'Signup failed. Try again.' });
    } finally {
        client.release();
    }
});

router.post('/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    const client = await pool.connect();
    try {
        const { rows } = await client.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
        const user = rows[0];
        // Same generic error whether the email doesn't exist or the password is
        // wrong — don't leak which one it was.
        if (!user) return res.status(401).json({ error: 'Invalid email or password.' });

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Invalid email or password.' });

        const accessToken = signAccessToken(user.id);
        const { token: refreshToken, tokenHash, expiresAt } = generateRefreshToken();
        await client.query(
            'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
            [user.id, tokenHash, expiresAt]
        );

        res.json({ user: publicUser(user), accessToken, refreshToken });
    } catch (err) {
        console.error('[auth/login] error:', err.message);
        res.status(500).json({ error: 'Login failed. Try again.' });
    } finally {
        client.release();
    }
});

router.post('/refresh', async (req, res) => {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ error: 'Missing refreshToken.' });

    const client = await pool.connect();
    try {
        const tokenHash = hashToken(refreshToken);
        const { rows } = await client.query(
            `SELECT rt.*, u.email FROM refresh_tokens rt
             JOIN users u ON u.id = rt.user_id
             WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > now()`,
            [tokenHash]
        );
        const record = rows[0];
        if (!record) return res.status(401).json({ error: 'Refresh token invalid or expired. Please log in again.' });

        // Rotate: revoke the used token, issue a new pair. Limits the damage
        // if a refresh token is ever stolen (it only works once).
        await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [record.id]);

        const accessToken = signAccessToken(record.user_id);
        const { token: newRefreshToken, tokenHash: newHash, expiresAt } = generateRefreshToken();
        await client.query(
            'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
            [record.user_id, newHash, expiresAt]
        );

        res.json({ accessToken, refreshToken: newRefreshToken });
    } catch (err) {
        console.error('[auth/refresh] error:', err.message);
        res.status(500).json({ error: 'Could not refresh session.' });
    } finally {
        client.release();
    }
});

router.post('/logout', async (req, res) => {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.json({ success: true }); // nothing to revoke, not an error
    try {
        await pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1', [hashToken(refreshToken)]);
    } catch (err) {
        console.warn('[auth/logout] revoke failed (non-fatal):', err.message);
    }
    res.json({ success: true });
});

router.get('/me', requireAuth, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT id, email, created_at FROM users WHERE id = $1', [req.userId]);
        if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
        res.json({ user: publicUser(rows[0]) });
    } catch (err) {
        console.error('[auth/me] error:', err.message);
        res.status(500).json({ error: 'Could not load account.' });
    }
});

module.exports = router;