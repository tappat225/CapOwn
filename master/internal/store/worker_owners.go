package store

import (
	"database/sql"
	"fmt"
)

// WorkerOwnerRow represents a row from worker_owners.
type WorkerOwnerRow struct {
	WorkerID   string
	UserID     string
	WorkerName string
	CreatedAt  string
	UpdatedAt  string
	RevokedAt  sql.NullString
}

func scanWorkerOwner(scanner interface {
	Scan(dest ...interface{}) error
}) (*WorkerOwnerRow, error) {
	o := &WorkerOwnerRow{}
	err := scanner.Scan(
		&o.WorkerID, &o.UserID, &o.WorkerName,
		&o.CreatedAt, &o.UpdatedAt, &o.RevokedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return o, nil
}

// SetOwner creates an owner binding for a worker.
func (s *Store) SetOwner(workerID, userID, workerName string) error {
	now := NowISO()
	_, err := s.db.Exec(
		`INSERT INTO worker_owners (worker_id, user_id, worker_name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
		workerID, userID, workerName, now, now)
	if err != nil {
		return fmt.Errorf("set owner: %w", err)
	}
	return nil
}

// GetOwner returns the owner binding for a worker.
func (s *Store) GetOwner(workerID string) (*WorkerOwnerRow, error) {
	row := s.db.QueryRow(
		`SELECT worker_id, user_id, worker_name, created_at, updated_at, revoked_at
		 FROM worker_owners WHERE worker_id = ? AND revoked_at IS NULL`, workerID)
	return scanWorkerOwner(row)
}

// IsOwner checks if a user owns a specific worker.
func (s *Store) IsOwner(userID, workerID string) (bool, error) {
	var count int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM worker_owners
		 WHERE worker_id = ? AND user_id = ? AND revoked_at IS NULL`,
		workerID, userID).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// ListOwnedWorkers returns all active owner bindings for a user.
func (s *Store) ListOwnedWorkers(userID string) ([]*WorkerOwnerRow, error) {
	rows, err := s.db.Query(
		`SELECT worker_id, user_id, worker_name, created_at, updated_at, revoked_at
		 FROM worker_owners WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var owners []*WorkerOwnerRow
	for rows.Next() {
		o, err := scanWorkerOwner(rows)
		if err != nil {
			return nil, err
		}
		owners = append(owners, o)
	}
	return owners, rows.Err()
}

// UpdateOwnerName updates the worker name in the owner binding.
func (s *Store) UpdateOwnerName(workerID, workerName string) error {
	now := NowISO()
	_, err := s.db.Exec(
		`UPDATE worker_owners SET worker_name = ?, updated_at = ? WHERE worker_id = ? AND revoked_at IS NULL`,
		workerName, now, workerID)
	return err
}

// RevokeOwnerBinding soft-deletes an owner binding.
func (s *Store) RevokeOwnerBinding(workerID string) error {
	now := NowISO()
	_, err := s.db.Exec(
		`UPDATE worker_owners SET revoked_at = ? WHERE worker_id = ? AND revoked_at IS NULL`,
		now, workerID)
	return err
}
