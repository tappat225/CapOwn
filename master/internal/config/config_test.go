package config

import (
	"path/filepath"
	"testing"
)

func TestLoadAllowedDashboardOriginsFromEnvironment(t *testing.T) {
	t.Setenv("CAPOWN_MASTER_DB_PATH", filepath.Join(t.TempDir(), "master.db"))
	t.Setenv(
		"CAPOWN_MASTER_ALLOWED_DASHBOARD_ORIGINS",
		" https://dashboard.example.com, http://localhost:3000, ",
	)

	cfg := Load("")
	want := []string{"https://dashboard.example.com", "http://localhost:3000"}
	if len(cfg.Master.AllowedDashboardOrigins) != len(want) {
		t.Fatalf("got %v origins, want %v", cfg.Master.AllowedDashboardOrigins, want)
	}
	for i, origin := range want {
		if cfg.Master.AllowedDashboardOrigins[i] != origin {
			t.Errorf("origin %d = %q, want %q", i, cfg.Master.AllowedDashboardOrigins[i], origin)
		}
	}
}
