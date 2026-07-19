package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

const invitationPrefix = "cown_invite_"

var (
	ErrInvitationInvalid = errors.New("invitation invalid")
	ErrUsernameConflict  = errors.New("username conflict")
)

type InvitationRow struct {
	InvitationID string
	CodeHash     string
	CodePrefix   string
	Label        string
	CreatedBy    string
	CreatedAt    string
	ExpiresAt    string
	UsedAt       sql.NullString
	UsedBy       sql.NullString
	RevokedAt    sql.NullString
}

func scanInvitation(scanner interface {
	Scan(dest ...interface{}) error
}) (*InvitationRow, error) {
	row := &InvitationRow{}
	err := scanner.Scan(
		&row.InvitationID, &row.CodeHash, &row.CodePrefix, &row.Label,
		&row.CreatedBy, &row.CreatedAt, &row.ExpiresAt,
		&row.UsedAt, &row.UsedBy, &row.RevokedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return row, err
}

func invitationDisplayPrefix(code string) string {
	const visibleRandomCharacters = 6
	end := len(invitationPrefix) + visibleRandomCharacters
	if len(code) < end {
		return code
	}
	return code[:end]
}

func (s *Store) CreateInvitation(createdBy, label string, ttl time.Duration) (string, *InvitationRow, error) {
	plaintext := invitationPrefix + GenerateToken()
	row := &InvitationRow{
		InvitationID: GenerateID(),
		CodeHash:     HashToken(plaintext),
		CodePrefix:   invitationDisplayPrefix(plaintext),
		Label:        label,
		CreatedBy:    createdBy,
		CreatedAt:    NowISO(),
		ExpiresAt:    time.Now().UTC().Add(ttl).Format(time.RFC3339),
	}
	_, err := s.db.Exec(
		`INSERT INTO user_invitations
		 (invitation_id, code_hash, code_prefix, label, created_by, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		row.InvitationID, row.CodeHash, row.CodePrefix, row.Label,
		row.CreatedBy, row.CreatedAt, row.ExpiresAt,
	)
	if err != nil {
		return "", nil, err
	}
	return plaintext, row, nil
}

func (s *Store) ListInvitations() ([]*InvitationRow, error) {
	rows, err := s.db.Query(
		`SELECT invitation_id, code_hash, code_prefix, label, created_by,
		        created_at, expires_at, used_at, used_by, revoked_at
		 FROM user_invitations ORDER BY created_at DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []*InvitationRow{}
	for rows.Next() {
		row, err := scanInvitation(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

func (s *Store) RevokeInvitation(invitationID string) (bool, error) {
	result, err := s.db.Exec(
		`UPDATE user_invitations SET revoked_at = ?
		 WHERE invitation_id = ? AND revoked_at IS NULL AND used_at IS NULL`,
		NowISO(), invitationID,
	)
	if err != nil {
		return false, err
	}
	count, _ := result.RowsAffected()
	return count > 0, nil
}

func (s *Store) RevokeInvitationsByCreator(userID string) error {
	_, err := s.db.Exec(
		`UPDATE user_invitations SET revoked_at = ?
		 WHERE created_by = ? AND revoked_at IS NULL AND used_at IS NULL`,
		NowISO(), userID,
	)
	return err
}

func InvitationStatus(row *InvitationRow, now time.Time) string {
	if row.RevokedAt.Valid {
		return "revoked"
	}
	if row.UsedAt.Valid {
		return "used"
	}
	expiresAt, err := time.Parse(time.RFC3339, row.ExpiresAt)
	if err != nil || !expiresAt.After(now) {
		return "expired"
	}
	return "active"
}

func (s *Store) RegisterInvitedUser(
	invitationCode, username, password string,
	sessionTTLSeconds int,
) (userID, sessionToken, expiresAt string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return "", "", "", fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	invitation, err := scanInvitation(tx.QueryRow(
		`SELECT invitation_id, code_hash, code_prefix, label, created_by,
		        created_at, expires_at, used_at, used_by, revoked_at
		 FROM user_invitations WHERE code_hash = ?`,
		HashToken(invitationCode),
	))
	if err != nil {
		return "", "", "", err
	}
	if invitation == nil || InvitationStatus(invitation, time.Now().UTC()) != "active" {
		return "", "", "", ErrInvitationInvalid
	}

	userID = GenerateID()
	now := NowISO()
	hash, salt := HashPassword(password)
	_, err = tx.Exec(
		`INSERT INTO users
		 (user_id, username, role, status, created_at, password_hash, password_salt, password_updated_at)
		 VALUES (?, ?, 'user', 'active', ?, ?, ?, ?)`,
		userID, username, now, hash, salt, now,
	)
	if err != nil {
		return "", "", "", ErrUsernameConflict
	}

	result, err := tx.Exec(
		`UPDATE user_invitations SET used_at = ?, used_by = ?
		 WHERE invitation_id = ? AND used_at IS NULL AND revoked_at IS NULL`,
		now, userID, invitation.InvitationID,
	)
	if err != nil {
		return "", "", "", err
	}
	updated, _ := result.RowsAffected()
	if updated != 1 {
		return "", "", "", ErrInvitationInvalid
	}

	sessionToken = "cown_web_" + GenerateToken()
	expiresAt = time.Now().UTC().Add(time.Duration(sessionTTLSeconds) * time.Second).Format(time.RFC3339)
	_, err = tx.Exec(
		`INSERT INTO user_sessions
		 (session_id, token_hash, token_prefix, user_id, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		GenerateID(), HashToken(sessionToken), TokenPrefix(sessionToken), userID, now, expiresAt,
	)
	if err != nil {
		return "", "", "", err
	}
	if err := tx.Commit(); err != nil {
		return "", "", "", err
	}
	return userID, sessionToken, expiresAt, nil
}
