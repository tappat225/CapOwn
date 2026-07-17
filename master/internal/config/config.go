package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

// Config holds all Master configuration.
type Config struct {
	Master Section `toml:"master"`
}

// Section is the [master] config section.
type Section struct {
	Host                    string   `toml:"host"`
	Port                    int      `toml:"port"`
	DBPath                  string   `toml:"db_path"`
	PublicURL               string   `toml:"public_url"`
	HeartbeatTimeout        int      `toml:"heartbeat_timeout"`
	SessionTTL              int      `toml:"session_ttl"`
	ChallengeTTL            int      `toml:"challenge_ttl"`
	AllowedDashboardOrigins []string `toml:"allowed_dashboard_origins"`
	RateLimit               int      `toml:"rate_limit"`
	MaxBodyBytes            int64    `toml:"max_body_bytes"`
	LogLevel                string   `toml:"log_level"`

	// MaxChallengeStoreSize limits the number of pending nonces.
	MaxChallengeStoreSize int `toml:"max_challenge_store_size"`
	// MaxSessionStoreSize limits the number of active worker sessions.
	MaxSessionStoreSize int `toml:"max_session_store_size"`
	// MaxWorkerEventQueues limits the number of concurrent worker SSE channels.
	MaxWorkerEventQueues int `toml:"max_worker_event_queues"`
	// SSEMaxConnectionsPerWorker limits concurrent SSE connections per worker.
	SSEMaxConnectionsPerWorker int `toml:"sse_max_connections_per_worker"`
	// MaxDashboardSubscribers limits concurrent dashboard SSE subscribers per user.
	MaxDashboardSubscribers int `toml:"max_dashboard_subscribers"`
	// PasswordHashConcurrency limits simultaneous password hashing operations.
	PasswordHashConcurrency int `toml:"password_hash_concurrency"`
}

// DefaultConfig returns a Config with sensible defaults.
func DefaultConfig() *Config {
	return &Config{
		Master: Section{
			Host:                       "0.0.0.0",
			Port:                       9210,
			DBPath:                     "./data/master.db",
			PublicURL:                  "",
			HeartbeatTimeout:           60,
			SessionTTL:                 28800,
			ChallengeTTL:               300,
			AllowedDashboardOrigins:    []string{},
			RateLimit:                  10,
			MaxBodyBytes:               65536,
			LogLevel:                   "info",
			MaxChallengeStoreSize:      1024,
			MaxSessionStoreSize:        4096,
			MaxWorkerEventQueues:       1024,
			SSEMaxConnectionsPerWorker: 1,
			MaxDashboardSubscribers:    64,
			PasswordHashConcurrency:    2,
		},
	}
}

// Load reads configuration from a TOML file, merging with defaults
// and environment variable overrides. Validates critical values.
func Load(path string) *Config {
	cfg := DefaultConfig()
	if path == "" {
		candidates := []string{"config.toml"}
		if home, err := os.UserHomeDir(); err == nil {
			candidates = append(candidates, filepath.Join(home, ".capown", "master", "config.toml"))
		}
		for _, candidate := range candidates {
			if _, err := os.Stat(candidate); err == nil {
				path = candidate
				break
			}
		}
	}

	if path != "" {
		data, err := os.ReadFile(path)
		if err == nil {
			if err := toml.Unmarshal(data, cfg); err != nil {
				fmt.Fprintf(os.Stderr, "warning: config parse error: %v\n", err)
			}
		}
	}

	// Environment variable overrides
	if v := os.Getenv("CAPOWN_MASTER_HOST"); v != "" {
		cfg.Master.Host = v
	}
	if v := os.Getenv("CAPOWN_MASTER_PORT"); v != "" {
		if p, err := strconv.Atoi(v); err == nil {
			cfg.Master.Port = p
		}
	}
	if v := os.Getenv("CAPOWN_MASTER_DB_PATH"); v != "" {
		cfg.Master.DBPath = v
	}
	if v := os.Getenv("CAPOWN_MASTER_PUBLIC_URL"); v != "" {
		cfg.Master.PublicURL = v
	}
	if v := os.Getenv("CAPOWN_MASTER_ALLOWED_DASHBOARD_ORIGINS"); v != "" {
		origins := make([]string, 0)
		for _, origin := range strings.Split(v, ",") {
			origin = strings.TrimSpace(origin)
			if origin != "" {
				origins = append(origins, origin)
			}
		}
		cfg.Master.AllowedDashboardOrigins = origins
	}
	if v := os.Getenv("CAPOWN_MASTER_LOG_LEVEL"); v != "" {
		cfg.Master.LogLevel = v
	}

	// Validate critical values
	if cfg.Master.HeartbeatTimeout < 2 {
		cfg.Master.HeartbeatTimeout = 2
	}
	if cfg.Master.Port <= 0 || cfg.Master.Port > 65535 {
		cfg.Master.Port = 9210
	}
	if cfg.Master.MaxBodyBytes < 1024 {
		cfg.Master.MaxBodyBytes = 1024
	}
	if cfg.Master.PasswordHashConcurrency < 1 {
		cfg.Master.PasswordHashConcurrency = 1
	}
	if cfg.Master.MaxChallengeStoreSize < 64 {
		cfg.Master.MaxChallengeStoreSize = 64
	}
	if cfg.Master.MaxSessionStoreSize < 64 {
		cfg.Master.MaxSessionStoreSize = 64
	}
	if cfg.Master.ChallengeTTL < 1 {
		cfg.Master.ChallengeTTL = 300
	}
	if cfg.Master.SessionTTL < 60 {
		cfg.Master.SessionTTL = 60
	}
	if cfg.Master.MaxWorkerEventQueues < 1 {
		cfg.Master.MaxWorkerEventQueues = 1
	}
	if cfg.Master.MaxDashboardSubscribers < 1 {
		cfg.Master.MaxDashboardSubscribers = 1
	}

	// Ensure DB path directory exists
	if cfg.Master.DBPath != "" {
		dir := filepath.Dir(cfg.Master.DBPath)
		if dir != "." {
			os.MkdirAll(dir, 0755)
		}
	}

	return cfg
}

// Addr returns the listen address string.
func (s *Section) Addr() string {
	return fmt.Sprintf("%s:%d", s.Host, s.Port)
}
