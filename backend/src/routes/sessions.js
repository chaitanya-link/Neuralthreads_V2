const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth); // every route below requires a valid access token

function toApiSession(row, attachmentSummaries = []) {
    return {
        id: row.id,
        platform: row.platform,
        title: row.title,
        url: row.url,
        summary: row.summary,
        aiSummary: row.ai_summary,
        tokenStats: row.token_stats,
        metadata: row.metadata,
        tags: row.tags,
        attachments: attachmentSummaries, // [{id, kind, filename, mime}] — no bytes here, see /attachments/:attId
        exportedAt: row.exported_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/**
 * GET /api/sessions?platform=claude&q=search+text&limit=20&cursor=<id>
 * Simple keyword search via pg_trgm for now — this is the pre-semantic-search
 * fallback. Swap/augment with a vector similarity query once chunks are
 * populated and the embedding pipeline is wired up (Phase 3).
 */
router.get('/', async (req, res) => {
    const { platform, q, limit = 20, cursor } = req.query;
    const params = [req.userId];
    const conditions = ['user_id = $1'];

    if (platform) {
        params.push(platform);
        conditions.push(`platform = $${params.length}`);
    }
    if (q && q.trim()) {
        params.push(`%${q.trim()}%`);
        conditions.push(`(title ILIKE $${params.length} OR summary ILIKE $${params.length})`);
    }
    if (cursor) {
        params.push(cursor);
        conditions.push(`created_at < (SELECT created_at FROM chat_sessions WHERE id = $${params.length})`);
    }

    const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    params.push(cappedLimit);

    try {
        const { rows } = await pool.query(
            `SELECT * FROM chat_sessions WHERE ${conditions.join(' AND ')}
             ORDER BY created_at DESC LIMIT $${params.length}`,
            params
        );
        res.json({
            sessions: rows.map((r) => toApiSession(r)),
            nextCursor: rows.length === cappedLimit ? rows[rows.length - 1].id : null,
        });
    } catch (err) {
        console.error('[sessions/list] error:', err.message);
        res.status(500).json({ error: 'Could not load sessions.' });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT * FROM chat_sessions WHERE id = $1 AND user_id = $2',
            [req.params.id, req.userId]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Session not found.' });

        const attRes = await pool.query(
            'SELECT id, kind, filename, mime FROM attachments WHERE session_id = $1 ORDER BY created_at',
            [req.params.id]
        );
        res.json({ session: toApiSession(rows[0], attRes.rows) });
    } catch (err) {
        console.error('[sessions/get] error:', err.message);
        res.status(500).json({ error: 'Could not load session.' });
    }
});

/** Attachment bytes are fetched separately, on demand — keeps the list/detail payloads light. */
router.get('/:id/attachments/:attachmentId', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT a.* FROM attachments a
             JOIN chat_sessions s ON s.id = a.session_id
             WHERE a.id = $1 AND a.session_id = $2 AND s.user_id = $3`,
            [req.params.attachmentId, req.params.id, req.userId]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Attachment not found.' });
        res.json({ attachment: rows[0] });
    } catch (err) {
        console.error('[sessions/attachment] error:', err.message);
        res.status(500).json({ error: 'Could not load attachment.' });
    }
});

/**
 * POST /api/sessions — mirrors the shape the extension already builds
 * locally in background.js's exportSession(). Raw `messages` are
 * intentionally NOT accepted here — see migrations/001_init.sql for why.
 */
router.post('/', async (req, res) => {
    const { platform, title, url, summary, aiSummary, tokenStats, metadata, tags, exportedAt, attachments } = req.body || {};
    if (!platform || !summary) return res.status(400).json({ error: 'platform and summary are required.' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `INSERT INTO chat_sessions (user_id, platform, title, url, summary, ai_summary, token_stats, metadata, tags, exported_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [
                req.userId, platform, title || null, url || null, summary,
                aiSummary !== false, tokenStats || null, metadata || null,
                Array.isArray(tags) ? tags : [], exportedAt ? new Date(exportedAt) : new Date(),
            ]
        );
        const session = rows[0];

        const attachmentRows = [];
        for (const att of Array.isArray(attachments) ? attachments : []) {
            if (!att.dataUrl) continue;
            const inserted = await client.query(
                `INSERT INTO attachments (session_id, kind, filename, mime, data_url)
                 VALUES ($1,$2,$3,$4,$5) RETURNING id, kind, filename, mime`,
                [session.id, att.kind || 'document', att.filename || null, att.mime || null, att.dataUrl]
            );
            attachmentRows.push(inserted.rows[0]);
        }

        await client.query('COMMIT');
        res.status(201).json({ session: toApiSession(session, attachmentRows) });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[sessions/create] error:', err.message);
        res.status(500).json({ error: 'Could not save session.' });
    } finally {
        client.release();
    }
});

/** PATCH /api/sessions/:id — currently just tags; extend as the dashboard grows (rename, etc). */
router.patch('/:id', async (req, res) => {
    const { tags } = req.body || {};
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be an array of strings.' });

    try {
        const { rows } = await pool.query(
            `UPDATE chat_sessions SET tags = $1, updated_at = now()
             WHERE id = $2 AND user_id = $3 RETURNING *`,
            [tags, req.params.id, req.userId]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Session not found.' });
        res.json({ session: toApiSession(rows[0]) });
    } catch (err) {
        console.error('[sessions/update] error:', err.message);
        res.status(500).json({ error: 'Could not update session.' });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const { rowCount } = await pool.query(
            'DELETE FROM chat_sessions WHERE id = $1 AND user_id = $2',
            [req.params.id, req.userId]
        );
        if (rowCount === 0) return res.status(404).json({ error: 'Session not found.' });
        res.json({ success: true });
    } catch (err) {
        console.error('[sessions/delete] error:', err.message);
        res.status(500).json({ error: 'Could not delete session.' });
    }
});

module.exports = router;