-- NeuralThreads v2 — initial schema
-- Run this once against your Neon (or any Postgres 14+) database.
-- pgvector is required for semantic search (Phase 3) — Neon supports it
-- out of the box via `CREATE EXTENSION`.

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS vector;    -- embeddings for semantic search
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- trigram search fallback for title search before semantic search ships

CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,          -- SHA-256 of the refresh token, never store it raw
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);

-- One row per exported conversation. Mirrors the shape the extension
-- already produces locally (see background.js exportSession) so syncing is
-- close to a direct field mapping, not a translation layer.
CREATE TABLE IF NOT EXISTS chat_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform        TEXT NOT NULL,              -- 'chatgpt' | 'claude' | 'gemini' | ...
    title           TEXT,
    url             TEXT,
    summary         TEXT,                       -- the RAG-compressed (or fallback) summary
    ai_summary      BOOLEAN NOT NULL DEFAULT true,
    token_stats     JSONB,                       -- { originalTokens, summaryTokens, savedTokens, savedPct }
    metadata        JSONB,                       -- { messageCount, hasCode, hasAttachments, attachmentCount, languages }
    tags            TEXT[] NOT NULL DEFAULT '{}',
    exported_at     TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_platform ON chat_sessions(platform);
CREATE INDEX IF NOT EXISTS idx_sessions_tags ON chat_sessions USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_sessions_title_trgm ON chat_sessions USING GIN (title gin_trgm_ops);

-- Raw text content stays OUT of this table on purpose — v1's architecture
-- deliberately never sends raw conversation text to any server (only the
-- compressed summary). We keep that promise in v2: full `messages` stay in
-- the extension's local chrome.storage only. If a future version adds
-- optional full-text cloud backup, it needs its own explicit opt-in and
-- column, not a silent default.

-- Chunk-level embeddings for semantic search (Phase 3). One summary can
-- produce several chunks if it's long; vector(768) matches Gemini's
-- gemini-embedding-001 at the 768-dim output setting (see background.js —
-- outputDimensionality: 768 is set explicitly there to match this).
CREATE TABLE IF NOT EXISTS chunks (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- denormalized for cheap per-user filtering
    text       TEXT NOT NULL,
    embedding  VECTOR(768),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);
-- IVFFlat index for approximate nearest-neighbor search. Needs rows present
-- before it's useful (run `ANALYZE chunks;` after your first real batch) —
-- harmless to create early.
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON chunks
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Attachments: captured images/docs (see content.js attachmentRefs,
-- background.js fetchAttachments). Stored as base64 for MVP simplicity —
-- matches what the extension already keeps locally. Move to real object
-- storage (S3/R2) once file sizes or volume make bytea impractical; noted
-- as a known v2.1 follow-up, not solved here.
CREATE TABLE IF NOT EXISTS attachments (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,       -- 'image' | 'document'
    filename   TEXT,
    mime       TEXT,
    data_url   TEXT,                -- base64 data: URI, same shape the extension already produces
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id);