package domain

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// --- Domain Types ---

type WorkerStatus string

const (
	WorkerOnline  WorkerStatus = "online"
	WorkerOffline WorkerStatus = "offline"
)

type UserRole string

const (
	RoleUser  UserRole = "user"
	RoleAdmin UserRole = "admin"
)

type UserStatus string

const (
	UserStatusActive   UserStatus = "active"
	UserStatusDisabled UserStatus = "disabled"
	UserStatusDeleted  UserStatus = "deleted"
)

type User struct {
	UserID           string `json:"user_id"`
	Username         string `json:"username"`
	Role             string `json:"role"`
	Status           string `json:"status"`
	CreatedAt        string `json:"created_at"`
	DisabledAt       string `json:"disabled_at,omitempty"`
	PasswordHash     string `json:"-"`
	PasswordSalt     string `json:"-"`
	PasswordUpdateAt string `json:"-"`
}

type Worker struct {
	WorkerID      string       `json:"worker_id"`
	WorkerName    string       `json:"worker_name"`
	OwnerUserID   string       `json:"owner_user_id"`
	PublicKey     string       `json:"public_key,omitempty"`
	Hostname      string       `json:"hostname"`
	OS            string       `json:"os"`
	Mode          string       `json:"mode"`
	Capabilities  string       `json:"capabilities"`
	Workspace     string       `json:"workspace"`
	Status        WorkerStatus `json:"status"`
	LastHeartbeat string       `json:"last_heartbeat,omitempty"`
	RegisteredAt  string       `json:"registered_at,omitempty"`
	RevokedAt     string       `json:"revoked_at,omitempty"`
}

type AuthToken struct {
	TokenID     string `json:"token_id"`
	UserID      string `json:"user_id"`
	TokenHash   string `json:"-"`
	TokenPrefix string `json:"token_prefix"`
	TokenType   string `json:"token_type"`
	Name        string `json:"name"`
	CreatedAt   string `json:"created_at"`
	LastUsedAt  string `json:"last_used_at,omitempty"`
	RevokedAt   string `json:"revoked_at,omitempty"`
}

type UserSession struct {
	SessionID   string `json:"session_id"`
	TokenHash   string `json:"-"`
	TokenPrefix string `json:"token_prefix"`
	UserID      string `json:"user_id"`
	CreatedAt   string `json:"created_at"`
	ExpiresAt   string `json:"expires_at"`
	LastUsedAt  string `json:"last_used_at,omitempty"`
	RevokedAt   string `json:"revoked_at,omitempty"`
}

type RegistrationToken struct {
	TokenID     string `json:"token_id"`
	TokenHash   string `json:"-"`
	TokenPrefix string `json:"token_prefix"`
	UserID      string `json:"user_id"`
	Scope       string `json:"scope"`
	ExpiresAt   string `json:"expires_at"`
	MaxUses     int    `json:"max_uses"`
	UsedCount   int    `json:"used_count"`
	RevokedAt   string `json:"revoked_at,omitempty"`
	CreatedAt   string `json:"created_at"`
	Label       string `json:"label"`
}

type WorkerOwner struct {
	WorkerID   string `json:"worker_id"`
	UserID     string `json:"user_id"`
	WorkerName string `json:"worker_name"`
	CreatedAt  string `json:"created_at"`
	UpdatedAt  string `json:"updated_at"`
	RevokedAt  string `json:"revoked_at,omitempty"`
}

// --- Helpers ---

// GenerateID returns a hex ID. For worker IDs use 24 chars (matching Python).
// For other IDs use 12 chars (matching Python uuid.uuid4().hex[:12]).
func GenerateID() string {
	b := make([]byte, 6)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// GenerateWorkerID returns a 24-hex-char worker ID with "wrk_" prefix (matching Python).
func GenerateWorkerID() string {
	b := make([]byte, 12)
	rand.Read(b)
	return "wrk_" + hex.EncodeToString(b)
}

// GenerateToken returns a 40-hex-char random token (matching Python secrets.token_hex(20)).
func GenerateToken() string {
	b := make([]byte, 20)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// HashToken returns the SHA-256 hex digest of a token.
func HashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

// TokenPrefix returns the first 6 characters of a token.
func TokenPrefix(token string) string {
	if len(token) >= 6 {
		return token[:6]
	}
	return token
}

// NowISO returns the current UTC time as an ISO 8601 string.
func NowISO() string {
	return time.Now().UTC().Format(time.RFC3339)
}

// ValidateWorkerNameSlug mirrors the TS Worker's makeWorkerNameSlug.
func ValidateWorkerNameSlug(name string) (string, string) {
	if name == "" {
		return "", "worker name is required"
	}

	// Lowercase
	slug := strings.ToLower(name)

	// Replace non-alphanumeric/non-hyphen with hyphens
	runes := make([]rune, 0, len(slug))
	for _, r := range slug {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			runes = append(runes, r)
		} else {
			runes = append(runes, '-')
		}
	}

	// Collapse multiple hyphens
	result := string(runes)
	for strings.Contains(result, "--") {
		result = strings.ReplaceAll(result, "--", "-")
	}

	// Strip leading/trailing hyphens
	result = strings.Trim(result, "-")

	// Handle empty result after filtering
	if result == "" {
		result = "worker"
	}

	// Check length constraints
	if len(result) < MinWorkerNameLen {
		result = result + strings.Repeat("-", MinWorkerNameLen-len(result))
	}
	if len(result) > MaxWorkerNameLen {
		result = result[:MaxWorkerNameLen]
		// Trim trailing hyphens after truncation
		result = strings.TrimRight(result, "-")
		if result == "" {
			result = "worker"
		}
	}

	// Check reserved names and wrk_ prefix
	if ReservedWorkerNames[result] {
		result = "n" + result
	}
	if strings.HasPrefix(result, ReservedWorkerIDPrefix) {
		result = "n" + result
	}

	return result, ""
}

// ReservedWorkerNames lists names that cannot be used.
var ReservedWorkerNames = map[string]bool{
	"master": true, "admin": true, "all": true,
	"none": true, "default": true, "self": true,
}

const (
	ReservedWorkerIDPrefix = "wrk_"
	MinWorkerNameLen       = 3
	MaxWorkerNameLen       = 48
)

// ValidateWorkerName checks a worker name and returns an error message, or "" if valid.
func ValidateWorkerName(name string) string {
	if name == "" {
		return "worker name is required"
	}
	if len(name) < MinWorkerNameLen {
		return fmt.Sprintf("worker name must be at least %d characters", MinWorkerNameLen)
	}
	if len(name) > MaxWorkerNameLen {
		return fmt.Sprintf("worker name must be at most %d characters", MaxWorkerNameLen)
	}
	if ReservedWorkerNames[strings.ToLower(name)] {
		return fmt.Sprintf("worker name %q is reserved", name)
	}
	if strings.HasPrefix(name, ReservedWorkerIDPrefix) {
		return fmt.Sprintf("worker name cannot start with %q", ReservedWorkerIDPrefix)
	}

	// Must match Python's ^[a-z0-9][a-z0-9._-]{1,46}[a-z0-9]$.
	for _, r := range name {
		if !((r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-') {
			return "worker name must contain only lowercase letters, digits, dots, hyphens, and underscores"
		}
	}

	first := name[0]
	last := name[len(name)-1]
	if !((first >= 'a' && first <= 'z') || (first >= '0' && first <= '9')) ||
		!((last >= 'a' && last <= 'z') || (last >= '0' && last <= '9')) {
		return "worker name must start and end with a lowercase letter or digit"
	}

	return ""
}

// --- Task types ---

type TaskStatus string

const (
	TaskPending   TaskStatus = "pending"
	TaskRunning   TaskStatus = "running"
	TaskCompleted TaskStatus = "completed"
	TaskFailed    TaskStatus = "failed"
	TaskTimeout   TaskStatus = "timeout"
	TaskCanceled  TaskStatus = "canceled"
)

// GenerateTaskID returns a task ID with "tsk_" prefix and 24 hex chars.
func GenerateTaskID() string {
	b := make([]byte, 12)
	rand.Read(b)
	return "tsk_" + hex.EncodeToString(b)
}

// ContentBlock represents a plugin result content block.
type ContentBlock struct {
	Type  string      `json:"type"`
	Text  string      `json:"text,omitempty"`
	Value interface{} `json:"value,omitempty"`
}

// PluginCallResult represents the result envelope for a plugin_call task.
type PluginCallResult struct {
	IsError           bool           `json:"is_error"`
	Content           []ContentBlock `json:"content"`
	StructuredContent interface{}    `json:"structured_content"`
}

// TaskResult is submitted by the Worker to report task completion.
type TaskResult struct {
	TaskID      string            `json:"task_id"`
	DeliveryID  string            `json:"delivery_id"`
	WorkerID    string            `json:"worker_id"`
	Status      TaskStatus        `json:"status"`
	Result      *PluginCallResult `json:"result,omitempty"`
	Error       *APIError         `json:"error,omitempty"`
	StartedAt   *string           `json:"started_at"`
	CompletedAt *string           `json:"completed_at"`
	Truncated   bool              `json:"truncated"`
}

// Task represents a dispatched task.
type Task struct {
	TaskID        string      `json:"task_id"`
	TargetWorker  string      `json:"target_worker"`
	TaskType      string      `json:"task_type"`
	Params        interface{} `json:"params,omitempty"`
	Status        TaskStatus  `json:"status"`
	TimeoutSecond int         `json:"timeout_seconds"`
	CreatedAt     string      `json:"created_at"`
	StartedAt     *string     `json:"started_at"`
	CompletedAt   *string     `json:"completed_at"`
	Result        interface{} `json:"result,omitempty"`
	Error         *APIError   `json:"error,omitempty"`
	Truncated     bool        `json:"truncated"`
	OwnerUserID   string      `json:"-"`
}

// --- Plugin types ---

// PluginToolInfo represents a discovered tool from a plugin.
type PluginToolInfo struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	InputSchema interface{} `json:"input_schema"`
}

// PluginInfo represents a plugin snapshot reported by the Worker.
type PluginInfo struct {
	PluginID  string           `json:"plugin_id"`
	Version   string           `json:"version"`
	Kind      string           `json:"kind"`
	Transport string           `json:"transport"`
	Enabled   bool             `json:"enabled"`
	Status    string           `json:"status"`
	Tools     []PluginToolInfo `json:"tools"`
	Error     string           `json:"error"`
}

// Token prefixes
const (
	TokenPrefixRegister = "cown_register_"
	TokenPrefixWeb      = "cown_web_"
	TokenPrefixSess     = "cown_sess_"
	TokenPrefixClient   = "" // client/admin tokens have no special prefix
)
