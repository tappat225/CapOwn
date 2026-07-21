package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
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

// SupersededWorker describes a prior registration replaced by a new one.
type SupersededWorker struct {
	WorkerID    string
	OwnerUserID string
	WorkerName  string
}

// RegisterWorkerResult describes a newly created or idempotently reused Worker.
type RegisterWorkerResult struct {
	WorkerID   string
	WorkerName string
	Created    bool
	Superseded []SupersededWorker
}

// RegisterWorkerAtomic atomically validates the token, supersedes any active
// registration for the key, creates the new Worker and owner binding, and
// consumes one token use. Repeating the same token and key is idempotent.
func (s *Store) RegisterWorkerAtomic(
	registrationToken, hostname, publicKey, osName, mode, capabilities, workspace string,
) (*RegisterWorkerResult, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return nil, "internal_error", fmt.Errorf("begin tx: %w", err)
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
		return nil, "registration_invalid", fmt.Errorf("token not found")
	}
	if err != nil {
		return nil, "internal_error", fmt.Errorf("query token: %w", err)
	}
	if revokedAt.Valid {
		return nil, "registration_invalid", fmt.Errorf("token revoked")
	}

	// Check expiry inside the same transaction
	expTime, err := ParseTimestamp(expiresAt)
	if err != nil || time.Now().UTC().After(expTime) {
		return nil, "registration_expired", fmt.Errorf("token expired")
	}

	// Normalize key material for stable uniqueness checks.
	publicKey = strings.ToLower(strings.TrimSpace(publicKey))

	// A retry is identified by the registration token and public key together.
	// The token remains multi-use: the same token can register many distinct
	// Workers, while a repeated request for one key returns its original result.
	var existingID, existingName, existingOwnerID string
	var existingRevokedAt sql.NullString
	existingErr := tx.QueryRow(
		`SELECT worker_id, worker_name, owner_user_id, revoked_at
		 FROM workers
		 WHERE registration_token_id = ? AND public_key = ?`,
		tokenID, publicKey,
	).Scan(&existingID, &existingName, &existingOwnerID, &existingRevokedAt)
	if existingErr == nil {
		if existingOwnerID != ownerID {
			return nil, "internal_error", fmt.Errorf("registration token owner mismatch")
		}
		if existingRevokedAt.Valid {
			return nil, "registration_superseded", fmt.Errorf("registration was superseded by a newer registration")
		}
		return &RegisterWorkerResult{
			WorkerID:   existingID,
			WorkerName: existingName,
			Created:    false,
		}, "", nil
	}
	if existingErr != sql.ErrNoRows {
		return nil, "internal_error", fmt.Errorf("query existing registration: %w", existingErr)
	}

	if usedCount >= maxUses {
		return nil, "registration_exhausted", fmt.Errorf("token exhausted")
	}

	// Capture active registrations for this installation before superseding
	// them. The public key may be reused by a transfer to another user.
	superseded, err := listActiveWorkersByPublicKey(tx, publicKey)
	if err != nil {
		return nil, "internal_error", fmt.Errorf("find prior Worker registrations: %w", err)
	}

	now := NowISO()
	for _, old := range superseded {
		if _, err := tx.Exec(
			`UPDATE workers SET revoked_at = ?, status = 'offline'
			 WHERE worker_id = ? AND revoked_at IS NULL`,
			now, old.WorkerID,
		); err != nil {
			return nil, "internal_error", fmt.Errorf("supersede Worker: %w", err)
		}
		if _, err := tx.Exec(
			`UPDATE worker_owners SET revoked_at = ?
			 WHERE worker_id = ? AND revoked_at IS NULL`,
			now, old.WorkerID,
		); err != nil {
			return nil, "internal_error", fmt.Errorf("supersede Worker owner: %w", err)
		}
	}

	workerName, err := chooseWorkerName(tx, ownerID, publicKey, hostname)
	if err != nil {
		return nil, "internal_error", fmt.Errorf("choose Worker name: %w", err)
	}

	// Create worker — use domain.GenerateWorkerID for proper wrk_ prefix.
	workerID := domain.GenerateWorkerID()
	_, err = tx.Exec(
		`INSERT INTO workers (worker_id, worker_name, owner_user_id, public_key, registration_token_id, hostname, os, mode, capabilities, workspace, status, registered_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline', ?)`,
		workerID, workerName, ownerID, publicKey, tokenID, hostname, osName, mode, capabilities, workspace, now,
	)
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "idx_worker_registration_identity") {
			return nil, "internal_error", fmt.Errorf("registration identity already exists")
		}
		return nil, "internal_error", fmt.Errorf("insert worker: %w", err)
	}

	// Create owner binding
	_, err = tx.Exec(
		`INSERT INTO worker_owners (worker_id, user_id, worker_name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
		workerID, ownerID, workerName, now, now,
	)
	if err != nil {
		return nil, "internal_error", fmt.Errorf("insert owner: %w", err)
	}

	// Consume registration token
	_, err = tx.Exec(
		`UPDATE registration_tokens SET used_count = used_count + 1 WHERE token_id = ?`, tokenID)
	if err != nil {
		return nil, "internal_error", fmt.Errorf("consume token: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, "internal_error", fmt.Errorf("commit: %w", err)
	}
	return &RegisterWorkerResult{
		WorkerID:   workerID,
		WorkerName: workerName,
		Created:    true,
		Superseded: superseded,
	}, "", nil
}

func listActiveWorkersByPublicKey(tx *sql.Tx, publicKey string) ([]SupersededWorker, error) {
	rows, err := tx.Query(
		`SELECT worker_id, owner_user_id, worker_name
		 FROM workers
		 WHERE public_key = ? AND revoked_at IS NULL`,
		publicKey,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []SupersededWorker
	for rows.Next() {
		var worker SupersededWorker
		if err := rows.Scan(&worker.WorkerID, &worker.OwnerUserID, &worker.WorkerName); err != nil {
			return nil, err
		}
		result = append(result, worker)
	}
	return result, rows.Err()
}

func chooseWorkerName(tx *sql.Tx, ownerID, publicKey, hostname string) (string, error) {
	var base string
	err := tx.QueryRow(
		`SELECT worker_name FROM workers
		 WHERE public_key = ?
		 ORDER BY registered_at DESC LIMIT 1`,
		publicKey,
	).Scan(&base)
	if err == sql.ErrNoRows {
		base, _ = domain.ValidateWorkerNameSlug(hostname)
	} else if err != nil {
		return "", err
	}
	if domain.ValidateWorkerName(base) != "" {
		base, _ = domain.ValidateWorkerNameSlug(hostname)
	}
	if base == "" {
		base = "worker"
	}

	for suffix := 0; suffix < 100000; suffix++ {
		candidate := base
		if suffix > 0 {
			suffixText := fmt.Sprintf("-%d", suffix+1)
			maxBaseLen := domain.MaxWorkerNameLen - len(suffixText)
			if maxBaseLen < domain.MinWorkerNameLen {
				maxBaseLen = domain.MinWorkerNameLen
			}
			if len(base) > maxBaseLen {
				candidate = strings.TrimRight(base[:maxBaseLen], "-._")
			}
			if candidate == "" {
				candidate = "worker"
			}
			candidate += suffixText
		}

		var conflictCount int
		if err := tx.QueryRow(
			`SELECT COUNT(*) FROM workers
			 WHERE worker_name = ? AND owner_user_id = ? AND revoked_at IS NULL`,
			candidate, ownerID,
		).Scan(&conflictCount); err != nil {
			return "", err
		}
		if conflictCount == 0 {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("could not allocate a unique Worker name")
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
