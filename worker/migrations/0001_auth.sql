-- Phase B – Schritt 1: Datenmodell für optionale Konten (Auth-Gerüst).
-- Noch KEINE Credits/Zahlung – nur Identität + Session. balances/ledger sind hier
-- vorwärts angelegt, aber in diesem Schritt UNGENUTZT (kein Schreib-/Lesepfad).
-- Alle Zeitstempel sind Unix-Sekunden (INTEGER). Tokens werden NIE im Klartext
-- gespeichert, nur als SHA-256-Hex.

-- Ein Konto pro E-Mail. E-Mail klein-normalisiert vom Worker.
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- Verknüpft Login-Methoden mit EINEM Konto: provider in ('magic','google').
-- Gleiche E-Mail über beide Wege -> derselbe user_id; beide Identitäten koppelbar.
CREATE TABLE IF NOT EXISTS identities (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  provider   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);

-- Opakes Session-Bearer-Token; gespeichert ist nur der Hash.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Magic-Link-Tokens: kurzlebig (~15 min), genau einmal einlösbar.
CREATE TABLE IF NOT EXISTS magic_tokens (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_magic_email ON magic_tokens(email);

-- CSRF-Schutz für den Google-OAuth-Flow: einmaliger state, kurzlebig (~10 min).
CREATE TABLE IF NOT EXISTS oauth_states (
  state      TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- --- Phase B (Credits) – HIER NOCH UNGENUTZT, nur Schema-Vorbereitung ---------
-- credits-Einheit wird in Phase B definiert (Vorschlag 1 Credit = 0,01 €). Kein
-- Code in diesem Schritt schreibt/liest diese Tabellen.
CREATE TABLE IF NOT EXISTS balances (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  credits    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  delta      INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  ref        TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id);
