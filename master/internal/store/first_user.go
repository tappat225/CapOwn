package store

import (
	"fmt"
	"time"
)

// RegisterFirstUser atomically creates the first admin user, sets password,
// and creates a web session. Only succeeds when no users exist yet.
func (s *Store) RegisterFirstUser(username, password string, sessionTTLSeconds int) (userID, sessionToken, expiresAt string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return "", "", "", fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	// Double-check no users exist (under lock)
	var count int
	tx.QueryRow("SELECT COUNT(*) FROM users").Scan(&count)
	if count > 0 {
		return "", "", "", fmt.Errorf("registration closed")
	}

	// Create user
	userID = GenerateID()
	createdAt := NowISO()
	_, err = tx.Exec(
		`INSERT INTO users (user_id, username, role, status, created_at)
		 VALUES (?, ?, 'admin', 'active', ?)`,
		userID, username, createdAt,
	)
	if err != nil {
		return "", "", "", fmt.Errorf("create user: %w", err)
	}

	// Set password
	hash, salt := HashPassword(password)
	now := NowISO()
	_, err = tx.Exec(
		`UPDATE users SET password_hash = ?, password_salt = ?, password_updated_at = ? WHERE user_id = ?`,
		hash, salt, now, userID,
	)
	if err != nil {
		return "", "", "", fmt.Errorf("set password: %w", err)
	}

	// Create session
	raw := GenerateToken()
	sessionToken = "cown_web_" + raw
	tokenHash := HashToken(sessionToken)
	prefix := TokenPrefix(sessionToken)
	sessionID := GenerateID()
	sessCreatedAt := NowISO()
	expiresAt = time.Now().UTC().Add(time.Duration(sessionTTLSeconds) * time.Second).Format(time.RFC3339)

	_, err = tx.Exec(
		`INSERT INTO user_sessions (session_id, token_hash, token_prefix, user_id, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		sessionID, tokenHash, prefix, userID, sessCreatedAt, expiresAt,
	)
	if err != nil {
		return "", "", "", fmt.Errorf("create session: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return "", "", "", fmt.Errorf("commit: %w", err)
	}

	return userID, sessionToken, expiresAt, nil
}
