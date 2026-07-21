package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/capown/master/internal/domain"
)

// WorkerRow represents a row from the workers table.
type WorkerRow struct {
	WorkerID           string
	WorkerName         string
	OwnerUserID        string
	PublicKey          string
	Hostname           string
	OS                 string
	Mode               string
	Capabilities       string
	Workspace          string
	Status             string
	LastHeartbeat      sql.NullString
	RegisteredAt       sql.NullString
	PreviousWorkerName sql.NullString
	RenamedAt          sql.NullString
	RevokedAt          sql.NullString
	Plugins            sql.NullString
}

func scanWorker(scanner interface {
	Scan(dest ...interface{}) error
}) (*WorkerRow, error) {
	w := &WorkerRow{}
	err := scanner.Scan(
		&w.WorkerID, &w.WorkerName, &w.OwnerUserID, &w.PublicKey,
		&w.Hostname, &w.OS, &w.Mode, &w.Capabilities,
		&w.Workspace, &w.Status, &w.LastHeartbeat, &w.RegisteredAt,
		&w.PreviousWorkerName, &w.RenamedAt, &w.RevokedAt, &w.Plugins,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return w, nil
}

// RegisterWorker creates a new worker record.
func (s *Store) RegisterWorker(
	workerID, workerName, ownerUserID, hostname, publicKey, osName, mode, capabilities, workspace string,
) error {
	now := NowISO()
	publicKey = strings.ToLower(strings.TrimSpace(publicKey))
	_, err := s.db.Exec(
		`INSERT INTO workers (worker_id, worker_name, owner_user_id, public_key, hostname, os, mode, capabilities, workspace, status, registered_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline', ?)`,
		workerID, workerName, ownerUserID, publicKey, hostname, osName, mode, capabilities, workspace, now,
	)
	if err != nil {
		return fmt.Errorf("register worker: %w", err)
	}
	return nil
}

// ReconnectWorker updates runtime metadata and sets status to online.
func (s *Store) ReconnectWorker(workerID, hostname, osName, mode, capabilities, workspace, plugins string) (*WorkerRow, bool, error) {
	now := NowISO()
	var prevStatus string
	err := s.db.QueryRow(`SELECT status FROM workers WHERE worker_id = ? AND revoked_at IS NULL`, workerID).Scan(&prevStatus)
	if err != nil {
		return nil, false, err
	}

	becameOnline := prevStatus == "offline"
	_, err = s.db.Exec(
		`UPDATE workers SET hostname = ?, os = ?, mode = ?, capabilities = ?, workspace = ?, plugins = ?, status = 'online', last_heartbeat = ?
		 WHERE worker_id = ? AND revoked_at IS NULL`,
		hostname, osName, mode, capabilities, workspace, plugins, now, workerID,
	)
	if err != nil {
		return nil, false, err
	}

	worker, err := s.GetWorker(workerID)
	return worker, becameOnline, err
}

// GetWorker looks up a worker by ID.
func (s *Store) GetWorker(workerID string) (*WorkerRow, error) {
	row := s.db.QueryRow(
		`SELECT worker_id, worker_name, owner_user_id, public_key, hostname, os, mode, capabilities, workspace, status, last_heartbeat, registered_at, previous_worker_name, renamed_at, revoked_at, plugins
		 FROM workers WHERE worker_id = ?`, workerID)
	return scanWorker(row)
}

// GetActiveWorker looks up a non-revoked worker.
func (s *Store) GetActiveWorker(workerID string) (*WorkerRow, error) {
	row := s.db.QueryRow(
		`SELECT worker_id, worker_name, owner_user_id, public_key, hostname, os, mode, capabilities, workspace, status, last_heartbeat, registered_at, previous_worker_name, renamed_at, revoked_at, plugins
		 FROM workers WHERE worker_id = ? AND revoked_at IS NULL`, workerID)
	return scanWorker(row)
}

// GetPublicKey returns the public key for a worker.
func (s *Store) GetPublicKey(workerID string) (string, error) {
	var key string
	err := s.db.QueryRow(`SELECT public_key FROM workers WHERE worker_id = ? AND revoked_at IS NULL`, workerID).Scan(&key)
	if err != nil {
		return "", err
	}
	return key, nil
}

// ListAllWorkers returns all workers.
func (s *Store) ListAllWorkers() ([]*WorkerRow, error) {
	rows, err := s.db.Query(
		`SELECT worker_id, worker_name, owner_user_id, public_key, hostname, os, mode, capabilities, workspace, status, last_heartbeat, registered_at, previous_worker_name, renamed_at, revoked_at, plugins
		 FROM workers ORDER BY registered_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var workers []*WorkerRow
	for rows.Next() {
		w, err := scanWorker(rows)
		if err != nil {
			return nil, err
		}
		workers = append(workers, w)
	}
	return workers, rows.Err()
}

// ListWorkersByOwner returns workers owned by a specific user (including revoked).
func (s *Store) ListWorkersByOwner(ownerUserID string) ([]*WorkerRow, error) {
	rows, err := s.db.Query(
		`SELECT worker_id, worker_name, owner_user_id, public_key, hostname, os, mode, capabilities, workspace, status, last_heartbeat, registered_at, previous_worker_name, renamed_at, revoked_at, plugins
		 FROM workers WHERE owner_user_id = ? ORDER BY registered_at`, ownerUserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var workers []*WorkerRow
	for rows.Next() {
		w, err := scanWorker(rows)
		if err != nil {
			return nil, err
		}
		workers = append(workers, w)
	}
	return workers, rows.Err()
}

// GetWorkerPlugins returns the plugin metadata JSON for a worker.
func (s *Store) GetWorkerPlugins(workerID string) ([]domain.PluginInfo, error) {
	row := s.db.QueryRow(`SELECT plugins FROM workers WHERE worker_id = ? AND revoked_at IS NULL`, workerID)
	var plugins sql.NullString
	if err := row.Scan(&plugins); err != nil {
		if err == sql.ErrNoRows {
			return []domain.PluginInfo{}, nil
		}
		return nil, err
	}
	if !plugins.Valid || plugins.String == "" {
		return []domain.PluginInfo{}, nil
	}
	var result []domain.PluginInfo
	if err := json.Unmarshal([]byte(plugins.String), &result); err != nil {
		return []domain.PluginInfo{}, nil
	}
	return result, nil
}

// MarkOffline sets a worker's status to offline.
func (s *Store) MarkOffline(workerID string) error {
	_, err := s.db.Exec(`UPDATE workers SET status = 'offline' WHERE worker_id = ? AND revoked_at IS NULL`, workerID)
	return err
}

// RenameWorker updates a worker's name.
func (s *Store) RenameWorker(workerID, newName string) error {
	now := NowISO()
	_, err := s.db.Exec(
		`UPDATE workers SET previous_worker_name = worker_name, worker_name = ?, renamed_at = ?
		 WHERE worker_id = ? AND revoked_at IS NULL`,
		newName, now, workerID)
	return err
}

// RevokeWorker sets revoked_at for a worker.
func (s *Store) RevokeWorker(workerID string) error {
	now := NowISO()
	_, err := s.db.Exec(`UPDATE workers SET revoked_at = ?, status = 'offline' WHERE worker_id = ? AND revoked_at IS NULL`,
		now, workerID)
	return err
}

// SweepStale finds workers whose heartbeat is older than timeoutSeconds and returns their IDs.
func (s *Store) SweepStale(timeoutSeconds int) ([]string, error) {
	cutoff := time.Now().UTC().Add(-time.Duration(timeoutSeconds) * time.Second).Format(time.RFC3339)
	rows, err := s.db.Query(
		`SELECT worker_id FROM workers WHERE status = 'online' AND revoked_at IS NULL AND (last_heartbeat IS NULL OR last_heartbeat < ?)`,
		cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
