// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

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
// (non-nil) Registry when no file is found so the server can still start.
func New(explicitPath string) (*Registry, error) {
	path := resolvePath(explicitPath)
	r := &Registry{
		catalog: &Catalog{Plugins: []PluginEntry{}},
		raw:     json.RawMessage(`{"schema_version":1,"updated_at":"","plugins":[]}`),
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
	r.catalog = &cat
	r.raw = json.RawMessage(data)
	return r, nil
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

// resolvePath finds the registry file.
func resolvePath(explicit string) string {
	if explicit != "" {
		return explicit
	}
	// Search relative to the working directory, then beside the executable.
	candidates := []string{
		filepath.Join("registry", "registry.json"),
		filepath.Join("..", "registry", "registry.json"),
	}
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
