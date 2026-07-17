package store

import (
	"database/sql"
	"fmt"
	"time"
)

// TokenRow represents a row from the auth_tokens table.
type TokenRow struct {
	TokenID     string
	UserID      string
	TokenHash   string
	TokenPrefix string
	TokenType   string
	Name        string
	CreatedAt   string
	LastUsedAt  sql.NullString
	RevokedAt   sql.NullString
}

func scanToken(scanner interface {
	Scan(dest ...interface{}) error
}) (*TokenRow, error) {
	t := &TokenRow{}
	err := scanner.Scan(
		&t.TokenID, &t.UserID, &t.TokenHash, &t.TokenPrefix,
		&t.TokenType, &t.Name, &t.CreatedAt, &t.LastUsedAt, &t.RevokedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return t, nil
}

// CreateToken creates a new API token. Returns the plaintext token and the row.
func (s *Store) CreateToken(userID, tokenType, name string) (plaintext string, token *TokenRow, err error) {
	raw := GenerateToken()
	plaintext = raw
	tokenHash := HashToken(raw)
	prefix := TokenPrefix(raw)
	tokenID := GenerateID()
	createdAt := NowISO()

	_, err = s.db.Exec(
		`INSERT INTO auth_tokens (token_id, user_id, token_hash, token_prefix, token_type, name, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		tokenID, userID, tokenHash, prefix, tokenType, name, createdAt)
	if err != nil {
		return "", nil, fmt.Errorf("create token: %w", err)
	}

	token = &TokenRow{
		TokenID:     tokenID,
		UserID:      userID,
		TokenHash:   tokenHash,
		TokenPrefix: prefix,
		TokenType:   tokenType,
		Name:        name,
		CreatedAt:   createdAt,
	}
	return plaintext, token, nil
}

// ValidateToken looks up a plaintext token and returns the token row if valid.
func (s *Store) ValidateToken(token string) (*TokenRow, error) {
	tokenHash := HashToken(token)
	t, err := s.getTokenByHash(tokenHash)
	if err != nil {
		return nil, err
	}
	if t == nil {
		return nil, nil
	}
	if t.RevokedAt.Valid {
		return nil, nil
	}
	return t, nil
}

func (s *Store) getTokenByHash(hash string) (*TokenRow, error) {
	row := s.db.QueryRow(
		`SELECT token_id, user_id, token_hash, token_prefix, token_type, name, created_at, last_used_at, revoked_at
		 FROM auth_tokens WHERE token_hash = ?`, hash)
	return scanToken(row)
}

// GetTokenByID looks up a token by token_id.
func (s *Store) GetTokenByID(tokenID string) (*TokenRow, error) {
	row := s.db.QueryRow(
		`SELECT token_id, user_id, token_hash, token_prefix, token_type, name, created_at, last_used_at, revoked_at
		 FROM auth_tokens WHERE token_id = ?`, tokenID)
	return scanToken(row)
}

// ListUserTokens lists tokens for a user.
func (s *Store) ListUserTokens(userID string) ([]*TokenRow, error) {
	rows, err := s.db.Query(
		`SELECT token_id, user_id, token_hash, token_prefix, token_type, name, created_at, last_used_at, revoked_at
		 FROM auth_tokens WHERE user_id = ? ORDER BY created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tokens []*TokenRow
	for rows.Next() {
		t, err := scanToken(rows)
		if err != nil {
			return nil, err
		}
		tokens = append(tokens, t)
	}
	return tokens, rows.Err()
}

// ListOwnedClientTokens lists non-revoked client tokens for a user.
func (s *Store) ListOwnedClientTokens(userID string) ([]*TokenRow, error) {
	rows, err := s.db.Query(
		`SELECT token_id, user_id, token_hash, token_prefix, token_type, name, created_at, last_used_at, revoked_at
		 FROM auth_tokens WHERE user_id = ? AND token_type = 'client' AND revoked_at IS NULL
		 ORDER BY created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tokens []*TokenRow
	for rows.Next() {
		t, err := scanToken(rows)
		if err != nil {
			return nil, err
		}
		tokens = append(tokens, t)
	}
	return tokens, rows.Err()
}

// RevokeToken soft-deletes a token by setting revoked_at.
func (s *Store) RevokeToken(tokenID string) error {
	now := NowISO()
	res, err := s.db.Exec(`UPDATE auth_tokens SET revoked_at = ? WHERE token_id = ?`, now, tokenID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("token not found")
	}
	return nil
}

// TouchToken updates last_used_at for a token.
func (s *Store) TouchToken(tokenID string) error {
	now := NowISO()
	_, err := s.db.Exec(`UPDATE auth_tokens SET last_used_at = ? WHERE token_id = ?`, now, tokenID)
	return err
}

// TokenExpiredIn returns a duration for token expiry warnings.
func TokenExpiredIn(token *TokenRow) bool {
	if token.RevokedAt.Valid {
		return true
	}
	return false
}

// CreateSessionToken creates a web session token (cown_web_*).
func (s *Store) CreateSessionToken(userID string, ttlSeconds int) (plaintext string, sessionID string, expiresAt string, err error) {
	raw := GenerateToken()
	plaintext = "cown_web_" + raw
	tokenHash := HashToken(plaintext)
	prefix := TokenPrefix(plaintext)
	sessionID = GenerateID()
	createdAt := NowISO()
	expiresAt = time.Now().UTC().Add(time.Duration(ttlSeconds) * time.Second).Format(time.RFC3339)

	_, err = s.db.Exec(
		`INSERT INTO user_sessions (session_id, token_hash, token_prefix, user_id, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		sessionID, tokenHash, prefix, userID, createdAt, expiresAt)
	if err != nil {
		return "", "", "", fmt.Errorf("create session: %w", err)
	}
	return plaintext, sessionID, expiresAt, nil
}

// SessionRow represents a row from user_sessions.
type SessionRow struct {
	SessionID   string
	TokenHash   string
	TokenPrefix string
	UserID      string
	CreatedAt   string
	ExpiresAt   string
	LastUsedAt  sql.NullString
	RevokedAt   sql.NullString
}

func scanSession(scanner interface {
	Scan(dest ...interface{}) error
}) (*SessionRow, error) {
	s := &SessionRow{}
	err := scanner.Scan(
		&s.SessionID, &s.TokenHash, &s.TokenPrefix,
		&s.UserID, &s.CreatedAt, &s.ExpiresAt,
		&s.LastUsedAt, &s.RevokedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return s, nil
}

// ValidateSession looks up a web session token and returns the session if valid.
func (s *Store) ValidateSession(token string) (*SessionRow, error) {
	tokenHash := HashToken(token)
	sess, err := s.getSessionByHash(tokenHash)
	if err != nil {
		return nil, err
	}
	if sess == nil {
		return nil, nil
	}
	if sess.RevokedAt.Valid {
		return nil, nil
	}

	// Check expiry — fail closed on parse errors
	expiresAt, err := ParseTimestamp(sess.ExpiresAt)
	if err != nil || time.Now().UTC().After(expiresAt) {
		return nil, nil
	}
	return sess, nil
}

func (s *Store) getSessionByHash(hash string) (*SessionRow, error) {
	row := s.db.QueryRow(
		`SELECT session_id, token_hash, token_prefix, user_id, created_at, expires_at, last_used_at, revoked_at
		 FROM user_sessions WHERE token_hash = ?`, hash)
	return scanSession(row)
}

// RevokeSession revokes a session by token.
func (s *Store) RevokeSession(token string) error {
	tokenHash := HashToken(token)
	now := NowISO()
	_, err := s.db.Exec(`UPDATE user_sessions SET revoked_at = ? WHERE token_hash = ?`, now, tokenHash)
	return err
}

// RevokeSessionByID revokes a session by session_id.
func (s *Store) RevokeSessionByID(sessionID string) error {
	now := NowISO()
	_, err := s.db.Exec(`UPDATE user_sessions SET revoked_at = ? WHERE session_id = ?`, now, sessionID)
	return err
}

// RevokeAllUserSessions revokes all sessions for a user.
func (s *Store) RevokeAllUserSessions(userID string) (int, error) {
	now := NowISO()
	res, err := s.db.Exec(`UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
		now, userID)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// ListUserSessions lists all sessions for a user (including revoked/expired).
func (s *Store) ListUserSessions(userID string) ([]*SessionRow, error) {
	rows, err := s.db.Query(
		`SELECT session_id, token_hash, token_prefix, user_id, created_at, expires_at, last_used_at, revoked_at
		 FROM user_sessions WHERE user_id = ? ORDER BY created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sessions []*SessionRow
	for rows.Next() {
		sess, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		sessions = append(sessions, sess)
	}
	return sessions, rows.Err()
}

// CleanExpiredSessions deletes expired sessions from the database.
func (s *Store) CleanExpiredSessions() (int, error) {
	now := NowISO()
	res, err := s.db.Exec(`DELETE FROM user_sessions WHERE expires_at < ?`, now)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}
