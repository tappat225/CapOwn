package store

import (
	"database/sql"
	"fmt"
	"time"
)

// RegistrationRow represents a row from registration_tokens.
type RegistrationRow struct {
	TokenID     string
	TokenHash   string
	TokenPrefix string
	UserID      string
	Scope       string
	ExpiresAt   string
	MaxUses     int
	UsedCount   int
	RevokedAt   sql.NullString
	CreatedAt   string
	Label       string
}

func scanRegistration(scanner interface {
	Scan(dest ...interface{}) error
}) (*RegistrationRow, error) {
	e := &RegistrationRow{}
	err := scanner.Scan(
		&e.TokenID, &e.TokenHash, &e.TokenPrefix, &e.UserID,
		&e.Scope, &e.ExpiresAt, &e.MaxUses, &e.UsedCount,
		&e.RevokedAt, &e.CreatedAt, &e.Label,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return e, nil
}

// CreateRegistrationToken creates a new registration token.
// Returns the plaintext token (with cown_register_ prefix).
func (s *Store) CreateRegistrationToken(userID string, ttlSeconds, maxUses int, label string) (plaintext string, token *RegistrationRow, err error) {
	raw := GenerateToken()
	plaintext = "cown_register_" + raw
	tokenHash := HashToken(plaintext)
	prefix := TokenPrefix(plaintext)
	tokenID := GenerateID()
	createdAt := NowISO()
	expiresAt := time.Now().UTC().Add(time.Duration(ttlSeconds) * time.Second).Format(time.RFC3339)

	_, err = s.db.Exec(
		`INSERT INTO registration_tokens (token_id, token_hash, token_prefix, user_id, scope, expires_at, max_uses, used_count, created_at, label)
		 VALUES (?, ?, ?, ?, 'worker', ?, ?, 0, ?, ?)`,
		tokenID, tokenHash, prefix, userID, expiresAt, maxUses, createdAt, label)
	if err != nil {
		return "", nil, fmt.Errorf("create registration: %w", err)
	}

	token = &RegistrationRow{
		TokenID:     tokenID,
		TokenHash:   tokenHash,
		TokenPrefix: prefix,
		UserID:      userID,
		Scope:       "worker",
		ExpiresAt:   expiresAt,
		MaxUses:     maxUses,
		UsedCount:   0,
		CreatedAt:   createdAt,
		Label:       label,
	}
	return plaintext, token, nil
}

// ValidateRegistrationToken looks up a plaintext registration token and validates it.
// Returns nil if invalid, expired, exhausted, or revoked.
func (s *Store) ValidateRegistrationToken(token string) (*RegistrationRow, error) {
	tokenHash := HashToken(token)
	e, err := s.getRegistrationByHash(tokenHash)
	if err != nil {
		return nil, err
	}
	if e == nil {
		return nil, nil
	}
	if e.RevokedAt.Valid {
		return nil, nil
	}

	// Check expiry
	expiresAt, err := ParseTimestamp(e.ExpiresAt)
	if err == nil && time.Now().UTC().After(expiresAt) {
		return nil, nil
	}

	// Check use count
	if e.UsedCount >= e.MaxUses {
		return nil, nil
	}

	return e, nil
}

func (s *Store) getRegistrationByHash(hash string) (*RegistrationRow, error) {
	row := s.db.QueryRow(
		`SELECT token_id, token_hash, token_prefix, user_id, scope, expires_at, max_uses, used_count, revoked_at, created_at, label
		 FROM registration_tokens WHERE token_hash = ?`, hash)
	return scanRegistration(row)
}

// ConsumeRegistrationToken increments the used_count for a registration token.
func (s *Store) ConsumeRegistrationToken(tokenID string) error {
	_, err := s.db.Exec(
		`UPDATE registration_tokens SET used_count = used_count + 1 WHERE token_id = ?`, tokenID)
	return err
}

// GetRegistrationTokenByID looks up a registration token by ID.
func (s *Store) GetRegistrationTokenByID(tokenID string) (*RegistrationRow, error) {
	row := s.db.QueryRow(
		`SELECT token_id, token_hash, token_prefix, user_id, scope, expires_at, max_uses, used_count, revoked_at, created_at, label
		 FROM registration_tokens WHERE token_id = ?`, tokenID)
	return scanRegistration(row)
}

// ListRegistrationTokens lists registration tokens for a user.
func (s *Store) ListRegistrationTokens(userID string) ([]*RegistrationRow, error) {
	rows, err := s.db.Query(
		`SELECT token_id, token_hash, token_prefix, user_id, scope, expires_at, max_uses, used_count, revoked_at, created_at, label
		 FROM registration_tokens WHERE user_id = ? ORDER BY created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tokens []*RegistrationRow
	for rows.Next() {
		t, err := scanRegistration(rows)
		if err != nil {
			return nil, err
		}
		tokens = append(tokens, t)
	}
	return tokens, rows.Err()
}

// RevokeRegistrationToken soft-deletes a registration token.
func (s *Store) RevokeRegistrationToken(tokenID string) error {
	now := NowISO()
	res, err := s.db.Exec(`UPDATE registration_tokens SET revoked_at = ? WHERE token_id = ?`, now, tokenID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("registration token not found")
	}
	return nil
}

// CleanExpiredRegistrationTokens deletes expired registration tokens.
func (s *Store) CleanExpiredRegistrationTokens() (int, error) {
	now := NowISO()
	res, err := s.db.Exec(`DELETE FROM registration_tokens WHERE expires_at < ?`, now)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}
