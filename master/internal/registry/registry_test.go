// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"os"
	"path/filepath"
	"testing"
)

const validRegistry = `{
  "schema_version": 1,
  "updated_at": "2026-07-20T00:00:00Z",
  "plugins": [
    {
      "plugin_id": "filesystem",
      "display_name": "Filesystem",
      "description": "Read, write, and manage files.",
      "icon": "folder",
      "tags": ["storage"],
      "publisher": "capown-official",
      "source": "bundled",
      "versions": [
        {
          "version": "0.1.0",
          "published_at": "2026-07-20T00:00:00Z",
          "package_url": "",
          "sha256": "",
          "requires": {"node": ">=20.18.0"},
          "manifest": {"command": ["node", "{{install_dir}}/index.js"]}
        }
      ]
    },
    {
      "plugin_id": "sqlite",
      "display_name": "SQLite",
      "description": "Local SQLite database plugin.",
      "icon": "database",
      "tags": ["database"],
      "publisher": "capown-official",
      "source": "registry",
      "versions": [
        {
          "version": "1.0.0",
          "published_at": "2026-07-20T00:00:00Z",
          "package_url": "https://cdn.example.com/sqlite-1.0.0.tar.gz",
          "sha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
          "requires": {"node": ">=20.18.0"},
          "manifest": {"command": ["node", "{{install_dir}}/dist/index.js"]}
        }
      ]
    }
  ]
}`

func writeTempRegistry(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "registry.json")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestNew_Valid(t *testing.T) {
	path := writeTempRegistry(t, validRegistry)
	r, err := New(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !r.HasPlugin("filesystem") {
		t.Error("expected filesystem plugin")
	}
	if !r.HasPlugin("sqlite") {
		t.Error("expected sqlite plugin")
	}
	if r.HasPlugin("nonexistent") {
		t.Error("unexpected nonexistent plugin")
	}
}

func TestNew_FileNotFound(t *testing.T) {
	r, err := New("/nonexistent/path/registry.json")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if r.HasPlugin("anything") {
		t.Error("expected empty catalog")
	}
}

func TestNew_EmptyPath(t *testing.T) {
	r, err := New("")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if r.HasPlugin("anything") {
		t.Error("expected empty catalog")
	}
}

func TestNew_InvalidJSON(t *testing.T) {
	path := writeTempRegistry(t, "{invalid")
	_, err := New(path)
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

func TestValidate_BadSchemaVersion(t *testing.T) {
	data := `{"schema_version":2,"updated_at":"2026-07-20T00:00:00Z","plugins":[]}`
	path := writeTempRegistry(t, data)
	_, err := New(path)
	if err == nil {
		t.Fatal("expected error for bad schema_version")
	}
}

func TestValidate_MissingUpdatedAt(t *testing.T) {
	data := `{"schema_version":1,"updated_at":"","plugins":[]}`
	path := writeTempRegistry(t, data)
	_, err := New(path)
	if err == nil {
		t.Fatal("expected error for empty updated_at")
	}
}

func TestValidate_DuplicatePluginID(t *testing.T) {
	data := `{"schema_version":1,"updated_at":"2026-07-20T00:00:00Z","plugins":[
		{"plugin_id":"dup","display_name":"A","source":"bundled","versions":[{"version":"1.0.0"}]},
		{"plugin_id":"dup","display_name":"B","source":"bundled","versions":[{"version":"1.0.0"}]}
	]}`
	path := writeTempRegistry(t, data)
	_, err := New(path)
	if err == nil {
		t.Fatal("expected error for duplicate plugin_id")
	}
}

func TestValidate_BadSource(t *testing.T) {
	data := `{"schema_version":1,"updated_at":"2026-07-20T00:00:00Z","plugins":[
		{"plugin_id":"bad","source":"unknown","versions":[{"version":"1.0.0"}]}
	]}`
	path := writeTempRegistry(t, data)
	_, err := New(path)
	if err == nil {
		t.Fatal("expected error for bad source")
	}
}

func TestValidate_EmptyVersions(t *testing.T) {
	data := `{"schema_version":1,"updated_at":"2026-07-20T00:00:00Z","plugins":[
		{"plugin_id":"empty","source":"bundled","versions":[]}
	]}`
	path := writeTempRegistry(t, data)
	_, err := New(path)
	if err == nil {
		t.Fatal("expected error for empty versions")
	}
}

func TestValidate_RegistryNoPackageURL(t *testing.T) {
	data := `{"schema_version":1,"updated_at":"2026-07-20T00:00:00Z","plugins":[
		{"plugin_id":"bad","source":"registry","versions":[{"version":"1.0.0","sha256":"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"}]}
	]}`
	path := writeTempRegistry(t, data)
	_, err := New(path)
	if err == nil {
		t.Fatal("expected error for missing package_url")
	}
}

func TestValidate_RegistryBadScheme(t *testing.T) {
	data := `{"schema_version":1,"updated_at":"2026-07-20T00:00:00Z","plugins":[
		{"plugin_id":"bad","source":"registry","versions":[{"version":"1.0.0","package_url":"http://example.com/p.tgz","sha256":"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"}]}
	]}`
	path := writeTempRegistry(t, data)
	_, err := New(path)
	if err == nil {
		t.Fatal("expected error for http package_url")
	}
}

func TestValidate_RegistryBadSHA256(t *testing.T) {
	data := `{"schema_version":1,"updated_at":"2026-07-20T00:00:00Z","plugins":[
		{"plugin_id":"bad","source":"registry","versions":[{"version":"1.0.0","package_url":"https://example.com/p.tgz","sha256":"tooshort"}]}
	]}`
	path := writeTempRegistry(t, data)
	_, err := New(path)
	if err == nil {
		t.Fatal("expected error for bad sha256")
	}
}

func TestResolveInstall_Found(t *testing.T) {
	path := writeTempRegistry(t, validRegistry)
	r, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	pin, err := r.ResolveInstall("sqlite", "1.0.0")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pin.PluginID != "sqlite" {
		t.Errorf("expected sqlite, got %s", pin.PluginID)
	}
	if pin.Version != "1.0.0" {
		t.Errorf("expected 1.0.0, got %s", pin.Version)
	}
	if pin.PackageURL != "https://cdn.example.com/sqlite-1.0.0.tar.gz" {
		t.Errorf("unexpected package_url: %s", pin.PackageURL)
	}
	if pin.SHA256 != "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789" {
		t.Errorf("unexpected sha256: %s", pin.SHA256)
	}
	if pin.Manifest == nil {
		t.Error("expected non-nil manifest")
	}
}

func TestResolveInstall_Latest(t *testing.T) {
	path := writeTempRegistry(t, validRegistry)
	r, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	pin, err := r.ResolveInstall("sqlite", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pin.Version != "1.0.0" {
		t.Errorf("expected latest version 1.0.0, got %s", pin.Version)
	}
}

func TestResolveInstall_NotFound(t *testing.T) {
	path := writeTempRegistry(t, validRegistry)
	r, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = r.ResolveInstall("nonexistent", "")
	if err == nil {
		t.Fatal("expected error for nonexistent plugin")
	}
}

func TestResolveInstall_Bundled(t *testing.T) {
	path := writeTempRegistry(t, validRegistry)
	r, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = r.ResolveInstall("filesystem", "")
	if err == nil {
		t.Fatal("expected error for bundled plugin")
	}
}

func TestResolveInstall_VersionNotFound(t *testing.T) {
	path := writeTempRegistry(t, validRegistry)
	r, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = r.ResolveInstall("sqlite", "9.9.9")
	if err == nil {
		t.Fatal("expected error for nonexistent version")
	}
}

func TestSource(t *testing.T) {
	path := writeTempRegistry(t, validRegistry)
	r, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	if r.Source("filesystem") != "bundled" {
		t.Error("expected bundled")
	}
	if r.Source("sqlite") != "registry" {
		t.Error("expected registry")
	}
	if r.Source("nonexistent") != "" {
		t.Error("expected empty")
	}
}

func TestIsBundled(t *testing.T) {
	path := writeTempRegistry(t, validRegistry)
	r, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	if !r.IsBundled("filesystem") {
		t.Error("expected filesystem to be bundled")
	}
	if r.IsBundled("sqlite") {
		t.Error("expected sqlite not to be bundled")
	}
}
