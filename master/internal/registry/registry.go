// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/capown/master/internal/domain"
)

var sha256RE = regexp.MustCompile(`^[0-9a-f]{64}$`)

// PluginVersion is one published version of a plugin in the registry.
type PluginVersion struct {
	Version     string                 `json:"version"`
	PublishedAt string                 `json:"published_at"`
	PackageURL  string                 `json:"package_url"`
	SHA256      string                 `json:"sha256"`
	Requires    map[string]string      `json:"requires"`
	Manifest    map[string]interface{} `json:"manifest"`
}

// PluginEntry is a single plugin in the registry catalog.
type PluginEntry struct {
	PluginID    string          `json:"plugin_id"`
	DisplayName string          `json:"display_name"`
	Description string          `json:"description"`
	Icon        string          `json:"icon"`
	Tags        []string        `json:"tags"`
	Publisher   string          `json:"publisher"`
	Source      string          `json:"source"`
	Versions    []PluginVersion `json:"versions"`
}

// PinnedInstall holds the fully resolved install parameters that the Master
// pins from the registry before enqueuing a plugin_install task.
type PinnedInstall struct {
	PluginID   string                 `json:"plugin_id"`
	Version    string                 `json:"version"`
	PackageURL string                 `json:"package_url"`
	SHA256     string                 `json:"sha256"`
	Manifest   map[string]interface{} `json:"manifest"`
}

// Catalog is the top-level registry document.
type Catalog struct {
	SchemaVersion int           `json:"schema_version"`
	UpdatedAt     string        `json:"updated_at"`
	Plugins       []PluginEntry `json:"plugins"`
}

// Registry loads and caches the plugin catalog.
type Registry struct {
	mu      sync.RWMutex
	catalog *Catalog
	raw     json.RawMessage
}

// New creates a Registry by loading the catalog from the given path.
// If path is empty, it searches default locations. Returns an empty
// Registry when no file is found so the server can still start, but
// returns an error for a malformed file that exists.
func New(explicitPath string) (*Registry, error) {
	path := resolvePath(explicitPath)
	r := &Registry{
		catalog: &Catalog{Plugins: []PluginEntry{}},
		// Empty catalog still uses a valid RFC 3339 updated_at for OpenAPI date-time.
		raw: json.RawMessage(`{"schema_version":1,"updated_at":"1970-01-01T00:00:00Z","plugins":[]}`),
	}
	if path == "" {
		return r, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return r, nil
		}
		return nil, fmt.Errorf("registry: read %s: %w", path, err)
	}
	var cat Catalog
	if err := json.Unmarshal(data, &cat); err != nil {
		return nil, fmt.Errorf("registry: parse %s: %w", path, err)
	}
	if err := validateCatalog(&cat); err != nil {
		return nil, fmt.Errorf("registry: validate %s: %w", path, err)
	}
	r.catalog = &cat
	r.raw = json.RawMessage(data)
	return r, nil
}

// validateCatalog checks structural constraints on the loaded registry.
func validateCatalog(cat *Catalog) error {
	if cat.SchemaVersion != 1 {
		return fmt.Errorf("schema_version must be 1, got %d", cat.SchemaVersion)
	}
	if cat.UpdatedAt == "" {
		return fmt.Errorf("updated_at is required")
	}
	if _, err := time.Parse(time.RFC3339, cat.UpdatedAt); err != nil {
		return fmt.Errorf("updated_at is not RFC 3339: %w", err)
	}
	seen := make(map[string]bool, len(cat.Plugins))
	for i, p := range cat.Plugins {
		if p.PluginID == "" {
			return fmt.Errorf("plugins[%d].plugin_id is required", i)
		}
		if seen[p.PluginID] {
			return fmt.Errorf("duplicate plugin_id %q", p.PluginID)
		}
		seen[p.PluginID] = true
		if p.Source != "bundled" && p.Source != "registry" {
			return fmt.Errorf("plugins[%d].source must be \"bundled\" or \"registry\", got %q", i, p.Source)
		}
		if len(p.Versions) == 0 {
			return fmt.Errorf("plugins[%d].versions must be non-empty", i)
		}
		for j, v := range p.Versions {
			if v.Version == "" {
				return fmt.Errorf("plugins[%d].versions[%d].version is required", i, j)
			}
			if p.Source == "registry" {
				if v.PackageURL == "" {
					return fmt.Errorf("plugins[%d].versions[%d].package_url is required for source \"registry\"", i, j)
				}
				if len(v.PackageURL) < 8 || v.PackageURL[:8] != "https://" {
					return fmt.Errorf("plugins[%d].versions[%d].package_url must start with https://, got %q", i, j, v.PackageURL)
				}
				if v.SHA256 == "" || !sha256RE.MatchString(v.SHA256) {
					return fmt.Errorf("plugins[%d].versions[%d].sha256 must be 64 hex chars for source \"registry\"", i, j)
				}
			}
		}
	}
	return nil
}

// RawJSON returns the original registry document bytes.
func (r *Registry) RawJSON() json.RawMessage {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.raw
}

// HasPlugin returns true if the plugin ID exists in the registry.
func (r *Registry) HasPlugin(pluginID string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, p := range r.catalog.Plugins {
		if p.PluginID == pluginID {
			return true
		}
	}
	return false
}

// GetPlugin returns the entry for a plugin ID, or nil.
func (r *Registry) GetPlugin(pluginID string) *PluginEntry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for i := range r.catalog.Plugins {
		if r.catalog.Plugins[i].PluginID == pluginID {
			return &r.catalog.Plugins[i]
		}
	}
	return nil
}

// Source returns the source type for a plugin ID, or empty string if not found.
func (r *Registry) Source(pluginID string) string {
	entry := r.GetPlugin(pluginID)
	if entry == nil {
		return ""
	}
	return entry.Source
}

// ResolveInstall looks up a plugin version and returns pinned install params.
// When version is empty the latest (first) version is used.
// Returns an error if the plugin is not found, is bundled, or the version
// is not in the registry.
func (r *Registry) ResolveInstall(pluginID, version string) (*PinnedInstall, error) {
	entry := r.GetPlugin(pluginID)
	if entry == nil {
		return nil, domain.NewAPIError(domain.ErrInvalidInput, fmt.Sprintf("plugin %q not found in registry", pluginID), 400)
	}
	if entry.Source == "bundled" {
		return nil, domain.NewAPIError(domain.ErrPluginBundled, fmt.Sprintf("plugin %q is bundled and cannot be installed via task", pluginID), 400)
	}
	var ver *PluginVersion
	if version == "" {
		ver = &entry.Versions[0]
	} else {
		for i := range entry.Versions {
			if entry.Versions[i].Version == version {
				ver = &entry.Versions[i]
				break
			}
		}
		if ver == nil {
			return nil, domain.NewAPIError(domain.ErrInvalidInput, fmt.Sprintf("plugin %q version %q not found in registry", pluginID, version), 400)
		}
	}
	return &PinnedInstall{
		PluginID:   pluginID,
		Version:    ver.Version,
		PackageURL: ver.PackageURL,
		SHA256:     ver.SHA256,
		Manifest:   ver.Manifest,
	}, nil
}

// IsBundled returns true if the plugin ID exists and has source "bundled".
func (r *Registry) IsBundled(pluginID string) bool {
	return r.Source(pluginID) == "bundled"
}

// resolvePath finds the registry file.
func resolvePath(explicit string) string {
	if explicit != "" {
		return explicit
	}
	candidates := []string{}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates, filepath.Join(home, ".capown", "master", "registry", "registry.json"))
	}
	candidates = append(candidates,
		filepath.Join("registry", "registry.json"),
		filepath.Join("..", "registry", "registry.json"),
	)
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), "registry", "registry.json"))
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return ""
}
