package domain

import (
	"testing"
)

func TestValidateWorkerName(t *testing.T) {
	tests := []struct {
		name  string
		valid bool
	}{
		{"my-worker", true},
		{"my-worker-1", true},
		{"my_worker.1", true},
		{"ab", false},         // too short
		{"", false},           // empty
		{"admin", false},      // reserved
		{"master", false},     // reserved
		{"wrk_worker", false}, // wrk_ prefix
		{"-worker", false},    // leading hyphen
		{"worker-", false},    // trailing hyphen
		{"Worker", false},     // uppercase
		{"worker/name", false},
	}
	for _, tt := range tests {
		msg := ValidateWorkerName(tt.name)
		if (msg == "") != tt.valid {
			t.Errorf("ValidateWorkerName(%q) = %q, want valid=%v", tt.name, msg, tt.valid)
		}
	}
}

func TestGenerateWorkerID(t *testing.T) {
	id := GenerateWorkerID()
	if len(id) != 28 {
		t.Errorf("expected 28-character worker ID, got %q", id)
	}
	if id[:4] != "wrk_" {
		t.Errorf("worker ID should start with wrk_: %q", id)
	}
}

func TestGenerateID(t *testing.T) {
	id := GenerateID()
	if len(id) != 12 {
		t.Errorf("expected 12-char ID, got %q (len=%d)", id, len(id))
	}
}

func TestHashToken(t *testing.T) {
	h := HashToken("test-token")
	if len(h) != 64 {
		t.Errorf("expected 64-char hex hash, got %d", len(h))
	}
	if h == "test-token" {
		t.Error("hash should not equal input")
	}
}

func TestTokenPrefix(t *testing.T) {
	if p := TokenPrefix("abcdef"); p != "abcdef" {
		t.Errorf("expected 'abcdef', got %q", p)
	}
	if p := TokenPrefix("abc"); p != "abc" {
		t.Errorf("expected 'abc', got %q", p)
	}
}

func TestReservedWorkerNames(t *testing.T) {
	for name := range ReservedWorkerNames {
		if msg := ValidateWorkerName(name); msg == "" {
			t.Errorf("reserved name %q should be rejected", name)
		}
	}
}
