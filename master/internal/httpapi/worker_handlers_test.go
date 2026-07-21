// SPDX-License-Identifier: Apache-2.0

package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/capown/master/internal/config"
)

func workerRegistrationRequest(t *testing.T, srv *Server, token, publicKey string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]interface{}{
		"registration_token": token,
		"public_key":         publicKey,
		"hostname":           "test-host",
		"os":                 "linux",
		"mode":               "capability",
		"capabilities":       []string{},
		"workspace":          "",
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/workers", bytes.NewReader(body))
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	return resp
}

func newWorkerHandlerTestServer(t *testing.T) *Server {
	t.Helper()
	cfg := config.DefaultConfig()
	cfg.Master.DBPath = filepath.Join(t.TempDir(), "master.db")
	srv, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = srv.store.Close() })
	return srv
}

func TestWorkerRegistrationIsIdempotentPerTokenAndIdentity(t *testing.T) {
	srv := newWorkerHandlerTestServer(t)
	user, err := srv.store.CreateUser("alice", "user")
	if err != nil {
		t.Fatal(err)
	}
	token, tokenRow, err := srv.store.CreateRegistrationToken(user.UserID, 3600, 2, "worker")
	if err != nil {
		t.Fatal(err)
	}
	publicKey := strings.Repeat("ab", 32)

	first := workerRegistrationRequest(t, srv, token, publicKey)
	if first.Code != http.StatusCreated {
		t.Fatalf("first registration status = %d, body = %s", first.Code, first.Body.String())
	}
	var firstBody map[string]string
	if err := json.Unmarshal(first.Body.Bytes(), &firstBody); err != nil {
		t.Fatal(err)
	}

	retry := workerRegistrationRequest(t, srv, token, strings.ToUpper(publicKey))
	if retry.Code != http.StatusOK {
		t.Fatalf("idempotent registration status = %d, body = %s", retry.Code, retry.Body.String())
	}
	var retryBody map[string]string
	if err := json.Unmarshal(retry.Body.Bytes(), &retryBody); err != nil {
		t.Fatal(err)
	}
	if retryBody["worker_id"] != firstBody["worker_id"] || retryBody["worker_name"] != "test-host" {
		t.Fatalf("retry returned a different Worker: first=%v retry=%v", firstBody, retryBody)
	}

	storedToken, err := srv.store.GetRegistrationTokenByID(tokenRow.TokenID)
	if err != nil {
		t.Fatal(err)
	}
	if storedToken.UsedCount != 1 {
		t.Fatalf("idempotent retry consumed the token again: used_count=%d", storedToken.UsedCount)
	}
}

func TestWorkerRegistrationTransfersIdentityToNewOwner(t *testing.T) {
	srv := newWorkerHandlerTestServer(t)
	firstOwner, err := srv.store.CreateUser("alice", "user")
	if err != nil {
		t.Fatal(err)
	}
	secondOwner, err := srv.store.CreateUser("bob", "user")
	if err != nil {
		t.Fatal(err)
	}
	firstToken, _, err := srv.store.CreateRegistrationToken(firstOwner.UserID, 3600, 2, "first")
	if err != nil {
		t.Fatal(err)
	}
	secondToken, secondTokenRow, err := srv.store.CreateRegistrationToken(secondOwner.UserID, 3600, 1, "second")
	if err != nil {
		t.Fatal(err)
	}
	publicKey := strings.Repeat("cd", 32)

	first := workerRegistrationRequest(t, srv, firstToken, publicKey)
	if first.Code != http.StatusCreated {
		t.Fatalf("first registration status = %d, body = %s", first.Code, first.Body.String())
	}

	var firstBody map[string]string
	if err := json.Unmarshal(first.Body.Bytes(), &firstBody); err != nil {
		t.Fatal(err)
	}

	transferred := workerRegistrationRequest(t, srv, secondToken, publicKey)
	if transferred.Code != http.StatusCreated {
		t.Fatalf("transfer status = %d, body = %s", transferred.Code, transferred.Body.String())
	}
	var transferredBody map[string]string
	if err := json.Unmarshal(transferred.Body.Bytes(), &transferredBody); err != nil {
		t.Fatal(err)
	}
	if transferredBody["worker_id"] == firstBody["worker_id"] || transferredBody["worker_name"] != "test-host" {
		t.Fatalf("transfer returned unexpected Worker: first=%v transferred=%v", firstBody, transferredBody)
	}
	if old, err := srv.store.GetActiveWorker(firstBody["worker_id"]); err != nil || old != nil {
		t.Fatalf("prior Worker should be revoked: %#v, %v", old, err)
	}
	storedToken, err := srv.store.GetRegistrationTokenByID(secondTokenRow.TokenID)
	if err != nil {
		t.Fatal(err)
	}
	if storedToken.UsedCount != 1 {
		t.Fatalf("transfer should consume the new token: used_count=%d", storedToken.UsedCount)
	}
}
