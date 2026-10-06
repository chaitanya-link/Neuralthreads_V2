const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const ACCESS_TOKEN_TTL = '15m';   // short-lived — matches the extension's maybeScheduleTokenRefresh() expectation
const REFRESH_TOKEN_TTL_DAYS = 30;

function requireSecret() {
    if (!process.env.JWT_SECRET) {
        throw new Error('JWT_SECRET is not set. Generate one with `node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"` and put it in .env');
    }
    return process.env.JWT_SECRET;
}

function signAccessToken(userId) {
    return jwt.sign({ sub: userId }, requireSecret(), { expiresIn: ACCESS_TOKEN_TTL });
}

/** Refresh tokens are random opaque strings, NOT JWTs — only their SHA-256 hash is stored, so a DB leak doesn't hand out usable tokens. */
function generateRefreshToken() {
    const token = crypto.randomBytes(48).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    return { token, tokenHash, expiresAt };
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/** Express middleware — verifies the Bearer access token and attaches req.userId. */
function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

    try {
        const payload = jwt.verify(token, requireSecret());
        req.userId = payload.sub;
        next();
    } catch (err) {
        // Distinguish expired (client should silently refresh) from invalid
        // (client should force re-login) — the dashboard's lib/api.js and
        // the extension's background.js both check this `code` field.
        const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
        return res.status(401).json({ error: 'Invalid or expired token', code });
    }
}

module.exports = { signAccessToken, generateRefreshToken, hashToken, requireAuth, ACCESS_TOKEN_TTL };