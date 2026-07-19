package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/capown/master/internal/domain"
)

var ErrWorkerNotFound = errors.New("worker not found")

// RegistrationContext is the validated result of a registration token lookup.
type RegistrationContext struct {
	UserID    string
	TokenID   string
	Scope     string
	MaxUses   int
	UsedCount int
}

// RegisterWorkerAtomic atomically: validates token, creates worker, creates owner binding, consumes token.
func (s *Store) RegisterWorkerAtomic(
	registrationToken, workerName, hostname, publicKey, osName, mode, capabilities, workspace string,
) (workerID string, errCode string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return "", "internal_error", fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	// Validate registration token
	tokenHash := HashToken(registrationToken)
	var (
		tokenID   string
		ownerID   string
		scope     string
		maxUses   int
		usedCount int
		expiresAt string
		revokedAt sql.NullString
	)
	err = tx.QueryRow(
		`SELECT token_id, user_id, scope, expires_at, max_uses, used_count, revoked_at
		 FROM registration_tokens WHERE token_hash = ?`, tokenHash,
	).Scan(&tokenID, &ownerID, &scope, &expiresAt, &maxUses, &usedCount, &revokedAt)
	if err == sql.ErrNoRows {
		return "", "registration_invalid", fmt.Errorf("token not found")
	}
	if err != nil {
		return "", "internal_error", fmt.Errorf("query token: %w", err)
	}
	if revokedAt.Valid {
		return "", "registration_invalid", fmt.Errorf("token revoked")
	}

	// Check expiry inside the same transaction
	expTime, err := ParseTimestamp(expiresAt)
	if err != nil || time.Now().UTC().After(expTime) {
		return "", "registration_expired", fmt.Errorf("token expired")
	}

	if usedCount >= maxUses {
		return "", "registration_exhausted", fmt.Errorf("token exhausted")
	}

	// Check for worker name conflict
	var conflictCount int
	tx.QueryRow(
		`SELECT COUNT(*) FROM workers WHERE worker_name = ? AND owner_user_id = ? AND revoked_at IS NULL`,
		workerName, ownerID).Scan(&conflictCount)
	if conflictCount > 0 {
		return "", "conflict", fmt.Errorf("worker name already taken")
	}

	// Create worker — use domain.GenerateWorkerID for proper wrk_ prefix
	workerID = domain.GenerateWorkerID()
	now := NowISO()
	_, err = tx.Exec(
		`INSERT INTO workers (worker_id, worker_name, owner_user_id, public_key, hostname, os, mode, capabilities, workspace, status, registered_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline', ?)`,
		workerID, workerName, ownerID, publicKey, hostname, osName, mode, capabilities, workspace, now,
	)
	if err != nil {
		return "", "internal_error", fmt.Errorf("insert worker: %w", err)
	}

	// Create owner binding
	_, err = tx.Exec(
		`INSERT INTO worker_owners (worker_id, user_id, worker_name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
		workerID, ownerID, workerName, now, now,
	)
	if err != nil {
		return "", "internal_error", fmt.Errorf("insert owner: %w", err)
	}

	// Consume registration token
	_, err = tx.Exec(
		`UPDATE registration_tokens SET used_count = used_count + 1 WHERE token_id = ?`, tokenID)
	if err != nil {
		return "", "internal_error", fmt.Errorf("consume token: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return "", "internal_error", fmt.Errorf("commit: %w", err)
	}
	return workerID, "", nil
}

// RevokeWorkerAtomic atomically revokes a worker and its owner binding.
func (s *Store) RevokeWorkerAtomic(workerID, userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	now := NowISO()

	// Revoke worker
	res, err := tx.Exec(
		`UPDATE workers SET revoked_at = ?, status = 'offline'
		 WHERE worker_id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
		now, workerID, userID)
	if err != nil {
		return fmt.Errorf("revoke worker: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("revoke worker rows: %w", err)
	}
	if affected == 0 {
		return ErrWorkerNotFound
	}

	// Revoke owner binding
	_, err = tx.Exec(
		`UPDATE worker_owners SET revoked_at = ?
		 WHERE worker_id = ? AND user_id = ? AND revoked_at IS NULL`,
		now, workerID, userID)
	if err != nil {
		return fmt.Errorf("revoke owner: %w", err)
	}

	return tx.Commit()
}

// RenameWorkerAtomic keeps the worker record and owner binding consistent.
func (s *Store) RenameWorkerAtomic(workerID, userID, newName string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin rename: %w", err)
	}
	defer tx.Rollback()

	now := NowISO()
	res, err := tx.Exec(
		`UPDATE workers SET previous_worker_name = worker_name, worker_name = ?, renamed_at = ?
		 WHERE worker_id = ? AND owner_user_id = ? AND revoked_at IS NULL`,
		newName, now, workerID, userID,
	)
	if err != nil {
		return fmt.Errorf("rename worker: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("rename worker rows: %w", err)
	}
	if affected == 0 {
		return ErrWorkerNotFound
	}
	if _, err := tx.Exec(
		`UPDATE worker_owners SET worker_name = ?, updated_at = ?
		 WHERE worker_id = ? AND user_id = ? AND revoked_at IS NULL`,
		newName, now, workerID, userID,
	); err != nil {
		return fmt.Errorf("rename owner binding: %w", err)
	}
	return tx.Commit()
}
