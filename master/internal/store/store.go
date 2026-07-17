package store

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"fmt"
	"sync"
	"time"

	"golang.org/x/crypto/pbkdf2"
	_ "modernc.org/sqlite"
)

// Store wraps a SQLite database with thread-safe access.
type Store struct {
	db     *sql.DB
	mu     sync.Mutex
	dbPath string
}

// New creates a new Store, opening the SQLite database and running migrations.
func New(dbPath string) (*Store, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	// SQLite connection-local pragmas such as foreign_keys must apply to
	// every operation. A single pooled connection is sufficient for this
	// minimal Master and also avoids inconsistent pragma state.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	// Enable WAL mode and foreign keys
	pragmas := []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA foreign_keys=ON",
		"PRAGMA busy_timeout=5000",
	}
	for _, p := range pragmas {
		if _, err := db.Exec(p); err != nil {
			return nil, fmt.Errorf("%s: %w", p, err)
		}
	}

	s := &Store{db: db, dbPath: dbPath}
	if err := s.initDB(); err != nil {
		return nil, fmt.Errorf("init db: %w", err)
	}
	return s, nil
}

// Close closes the database.
func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) initDB() error {
	tables := []string{
		`CREATE TABLE IF NOT EXISTS users (
			user_id      TEXT PRIMARY KEY,
			username     TEXT NOT NULL UNIQUE,
			role         TEXT NOT NULL DEFAULT 'user',
			status       TEXT NOT NULL DEFAULT 'active',
			created_at   TEXT NOT NULL,
			disabled_at  TEXT,
			password_hash TEXT NOT NULL DEFAULT '',
			password_salt TEXT NOT NULL DEFAULT '',
			password_updated_at TEXT NOT NULL DEFAULT ''
		)`,

		`CREATE TABLE IF NOT EXISTS auth_tokens (
			token_id     TEXT PRIMARY KEY,
			user_id      TEXT NOT NULL REFERENCES users(user_id),
			token_hash   TEXT NOT NULL UNIQUE,
			token_prefix TEXT NOT NULL,
			token_type   TEXT NOT NULL,
			name         TEXT NOT NULL DEFAULT '',
			created_at   TEXT NOT NULL,
			last_used_at TEXT,
			revoked_at   TEXT
		)`,

		`CREATE TABLE IF NOT EXISTS user_sessions (
			session_id   TEXT PRIMARY KEY,
			token_hash   TEXT NOT NULL UNIQUE,
			token_prefix TEXT NOT NULL,
			user_id      TEXT NOT NULL REFERENCES users(user_id),
			created_at   TEXT NOT NULL,
			expires_at   TEXT NOT NULL,
			last_used_at TEXT,
			revoked_at   TEXT
		)`,

		`CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at)`,

		`CREATE TABLE IF NOT EXISTS registration_tokens (
			token_id     TEXT PRIMARY KEY,
			token_hash   TEXT NOT NULL UNIQUE,
			token_prefix TEXT NOT NULL,
			user_id      TEXT NOT NULL REFERENCES users(user_id),
			scope        TEXT NOT NULL DEFAULT 'worker',
			expires_at   TEXT NOT NULL,
			max_uses     INTEGER NOT NULL DEFAULT 1,
			used_count   INTEGER NOT NULL DEFAULT 0,
			revoked_at   TEXT,
			created_at   TEXT NOT NULL,
			label        TEXT NOT NULL DEFAULT ''
		)`,

		`CREATE TABLE IF NOT EXISTS workers (
			worker_id TEXT PRIMARY KEY,
			worker_name TEXT NOT NULL,
			owner_user_id TEXT NOT NULL,
			public_key TEXT NOT NULL DEFAULT '',
			hostname TEXT NOT NULL,
			os TEXT DEFAULT 'linux',
			mode TEXT DEFAULT 'container',
			capabilities TEXT DEFAULT 'shell,file',
			workspace TEXT DEFAULT '/workspace',
			status TEXT DEFAULT 'online',
			last_heartbeat TEXT,
			registered_at TEXT,
			previous_worker_name TEXT,
			renamed_at TEXT,
			revoked_at TEXT
		)`,

		`CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_name_active
		 ON workers(worker_name, owner_user_id) WHERE revoked_at IS NULL`,

		`CREATE TABLE IF NOT EXISTS worker_owners (
			worker_id    TEXT PRIMARY KEY,
			user_id      TEXT NOT NULL REFERENCES users(user_id),
			worker_name  TEXT NOT NULL,
			created_at   TEXT NOT NULL,
			updated_at   TEXT NOT NULL,
			revoked_at   TEXT
		)`,

		`CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_owner_name_active
		 ON worker_owners(worker_name, user_id) WHERE revoked_at IS NULL`,
	}

	for _, stmt := range tables {
		if _, err := s.db.Exec(stmt); err != nil {
			return err
		}
	}
	for _, migration := range []struct {
		column     string
		definition string
	}{
		{"previous_worker_name", "TEXT"},
		{"renamed_at", "TEXT"},
	} {
		exists, err := s.columnExists("workers", migration.column)
		if err != nil {
			return err
		}
		if !exists {
			if _, err := s.db.Exec("ALTER TABLE workers ADD COLUMN " + migration.column + " " + migration.definition); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Store) columnExists(table, column string) (bool, error) {
	rows, err := s.db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, dataType string
		var notNull, primaryKey int
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &dataType, &notNull, &defaultValue, &primaryKey); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

// rawDB returns the underlying *sql.DB for use by internal store methods.
func (s *Store) rawDB() *sql.DB { return s.db }

// Lock locks the store mutex for transactional operations.
func (s *Store) Lock() { s.mu.Lock() }

// Unlock unlocks the store mutex.
func (s *Store) Unlock() { s.mu.Unlock() }

// CountUsers returns the number of registered users.
func (s *Store) CountUsers() int {
	var count int
	s.db.QueryRow("SELECT COUNT(*) FROM users").Scan(&count)
	return count
}

// --- PBKDF2 Password Helpers ---

const PBKDF2Iterations = 600_000

// HashPassword returns PBKDF2-HMAC-SHA256 hash and random 16-byte hex salt (Python-compatible).
func HashPassword(password string) (hash, salt string) {
	saltBytes := make([]byte, 16)
	rand.Read(saltBytes)
	salt = hex.EncodeToString(saltBytes)
	dk := pbkdf2.Key([]byte(password), []byte(salt), PBKDF2Iterations, 32, sha256.New)
	hash = hex.EncodeToString(dk)
	return
}

// VerifyPassword checks a password against a stored hash and salt (constant-time).
func VerifyPassword(password, storedHash, salt string) bool {
	if storedHash == "" || salt == "" {
		return false
	}
	dk := pbkdf2.Key([]byte(password), []byte(salt), PBKDF2Iterations, 32, sha256.New)
	computed := hex.EncodeToString(dk)
	return subtle.ConstantTimeCompare([]byte(computed), []byte(storedHash)) == 1
}

// HashToken returns the SHA-256 hex digest of a token.
func HashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

// GenerateID returns a 12-hex-char ID matching Python's uuid.uuid4().hex[:12].
func GenerateID() string {
	b := make([]byte, 6)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// GenerateToken returns a 40-hex-char random token (matching Python secrets.token_hex(20)).
func GenerateToken() string {
	b := make([]byte, 20)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// TokenPrefix returns the first 6 chars of a token.
func TokenPrefix(token string) string {
	if len(token) >= 6 {
		return token[:6]
	}
	return token
}

// NowISO returns the current UTC time as ISO 8601.
func NowISO() string {
	return time.Now().UTC().Format(time.RFC3339)
}

// ParseTimestamp accepts both Go RFC3339 timestamps and the timezone-less
// datetime.isoformat() values written by the Python Master.
func ParseTimestamp(value string) (time.Time, error) {
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed.UTC(), nil
	}
	for _, layout := range []string{
		"2006-01-02T15:04:05.999999999",
		"2006-01-02T15:04:05",
	} {
		if parsed, err := time.ParseInLocation(layout, value, time.UTC); err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, fmt.Errorf("invalid timestamp %q", value)
}
