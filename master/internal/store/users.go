package store

import (
	"database/sql"
	"fmt"
)

// CreateUser inserts a new user. Caller must set password separately.
func (s *Store) CreateUser(username, role string) (*UserRow, error) {
	userID := GenerateID()
	createdAt := NowISO()

	_, err := s.db.Exec(`INSERT INTO users (user_id, username, role, status, created_at)
		VALUES (?, ?, ?, 'active', ?)`, userID, username, role, createdAt)
	if err != nil {
		return nil, fmt.Errorf("create user: %w", err)
	}
	return s.GetUser(username)
}

// CreateUserWithPassword atomically creates a login-ready user.
func (s *Store) CreateUserWithPassword(username, role, password string) (*UserRow, error) {
	hash, salt := HashPassword(password)
	userID := GenerateID()
	now := NowISO()

	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin create user: %w", err)
	}
	defer tx.Rollback()

	_, err = tx.Exec(
		`INSERT INTO users
		 (user_id, username, role, status, created_at, password_hash, password_salt, password_updated_at)
		 VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
		userID, username, role, now, hash, salt, now,
	)
	if err != nil {
		return nil, fmt.Errorf("create user: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit create user: %w", err)
	}
	return s.GetUserByID(userID)
}

type UserRow struct {
	UserID           string
	Username         string
	Role             string
	Status           string
	CreatedAt        string
	DisabledAt       sql.NullString
	PasswordHash     string
	PasswordSalt     string
	PasswordUpdateAt string
}

// scanUser scans a user row from a *sql.Row or *sql.Rows.
func scanUser(scanner interface {
	Scan(dest ...interface{}) error
}) (*UserRow, error) {
	u := &UserRow{}
	err := scanner.Scan(
		&u.UserID, &u.Username, &u.Role, &u.Status,
		&u.CreatedAt, &u.DisabledAt,
		&u.PasswordHash, &u.PasswordSalt, &u.PasswordUpdateAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return u, nil
}

// GetUser looks up a user by username.
func (s *Store) GetUser(username string) (*UserRow, error) {
	row := s.db.QueryRow(
		`SELECT user_id, username, role, status, created_at, disabled_at,
			password_hash, password_salt, password_updated_at
		 FROM users WHERE username = ?`, username)
	return scanUser(row)
}

// GetUserByID looks up a user by user_id.
func (s *Store) GetUserByID(userID string) (*UserRow, error) {
	row := s.db.QueryRow(
		`SELECT user_id, username, role, status, created_at, disabled_at,
			password_hash, password_salt, password_updated_at
		 FROM users WHERE user_id = ?`, userID)
	return scanUser(row)
}

// ListUsers returns all users.
func (s *Store) ListUsers() ([]*UserRow, error) {
	rows, err := s.db.Query(
		`SELECT user_id, username, role, status, created_at, disabled_at,
			password_hash, password_salt, password_updated_at
		 FROM users ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []*UserRow
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

// SetPassword sets the password hash and salt for a user.
func (s *Store) SetPassword(userID, password string) error {
	hash, salt := HashPassword(password)
	now := NowISO()
	_, err := s.db.Exec(
		`UPDATE users SET password_hash = ?, password_salt = ?, password_updated_at = ? WHERE user_id = ?`,
		hash, salt, now, userID)
	return err
}

// HasPassword checks if a user has a password set.
func (s *Store) HasPassword(userID string) (bool, error) {
	var pwHash string
	err := s.db.QueryRow(`SELECT password_hash FROM users WHERE user_id = ?`, userID).Scan(&pwHash)
	if err != nil {
		return false, err
	}
	return pwHash != "", nil
}

// SetUserRole updates a user's role.
func (s *Store) SetUserRole(userID, role string) error {
	_, err := s.db.Exec(`UPDATE users SET role = ? WHERE user_id = ?`, role, userID)
	return err
}

// SetUserStatus enables or disables a user.
func (s *Store) SetUserStatus(userID, status string) error {
	now := NowISO()
	if status != "active" {
		_, err := s.db.Exec(`UPDATE users SET status = ?, disabled_at = ? WHERE user_id = ?`,
			status, now, userID)
		return err
	}
	_, err := s.db.Exec(`UPDATE users SET status = ?, disabled_at = NULL WHERE user_id = ?`,
		status, userID)
	return err
}

// RenameUser renames a user.
func (s *Store) RenameUser(userID, newUsername string) error {
	_, err := s.db.Exec(`UPDATE users SET username = ? WHERE user_id = ?`, newUsername, userID)
	return err
}

// UserToDomain converts a UserRow to a domain.User.
func UserToDomain(u *UserRow) map[string]interface{} {
	if u == nil {
		return nil
	}
	result := map[string]interface{}{
		"user_id":    u.UserID,
		"username":   u.Username,
		"role":       u.Role,
		"status":     u.Status,
		"created_at": u.CreatedAt,
	}
	if u.DisabledAt.Valid {
		result["disabled_at"] = u.DisabledAt.String
	}
	return result
}
