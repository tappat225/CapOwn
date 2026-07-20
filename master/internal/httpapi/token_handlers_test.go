package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/capown/master/internal/config"
)

func newTokenTestServer(t *testing.T) (*Server, string, string, string) {
	t.Helper()
	cfg := config.DefaultConfig()
	cfg.Master.DBPath = filepath.Join(t.TempDir(), "master.db")
	srv, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = srv.store.Close() })

	user, err := srv.store.CreateUser("alice", "user")
	if err != nil {
		t.Fatal(err)
	}
	webToken, _, _, err := srv.store.CreateSessionToken(user.UserID, 3600)
	if err != nil {
		t.Fatal(err)
	}
	clientToken, token, err := srv.store.CreateToken(user.UserID, "client", "dashboard")
	if err != nil {
		t.Fatal(err)
	}
	return srv, webToken, clientToken, token.TokenID
}

func tokenHTTPResponse(t *testing.T, srv *Server, method, path, bearer string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+bearer)
	req.RemoteAddr = "198.51.100.24:4567"
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	return resp
}

func TestClientTokenStatusAndUsageEndpoints(t *testing.T) {
	srv, webToken, clientToken, tokenID := newTokenTestServer(t)

	usageResp := tokenHTTPResponse(t, srv, http.MethodGet, "/v1/workers", clientToken, nil)
	if usageResp.Code != http.StatusOK {
		t.Fatalf("client request status = %d, body = %s", usageResp.Code, usageResp.Body.String())
	}
	row, err := srv.store.GetTokenByID(tokenID)
	if err != nil {
		t.Fatal(err)
	}
	if !row.LastUsedAt.Valid || row.LastUsedIP.String != "198.51.100.24" {
		t.Fatalf("client usage was not audited: %#v", row)
	}

	disableResp := tokenHTTPResponse(
		t,
		srv,
		http.MethodPatch,
		"/v1/tokens/"+tokenID,
		webToken,
		[]byte(`{"status":"disabled"}`),
	)
	if disableResp.Code != http.StatusOK {
		t.Fatalf("disable status = %d, body = %s", disableResp.Code, disableResp.Body.String())
	}
	var disabled map[string]interface{}
	if err := json.Unmarshal(disableResp.Body.Bytes(), &disabled); err != nil {
		t.Fatal(err)
	}
	if disabled["status"] != "disabled" || disabled["disabled_at"] == nil {
		t.Fatalf("disable response = %#v", disabled)
	}

	blockedResp := tokenHTTPResponse(t, srv, http.MethodGet, "/v1/workers", clientToken, nil)
	if blockedResp.Code != http.StatusUnauthorized {
		t.Fatalf("disabled client status = %d, body = %s", blockedResp.Code, blockedResp.Body.String())
	}

	enableResp := tokenHTTPResponse(
		t,
		srv,
		http.MethodPatch,
		"/v1/tokens/"+tokenID,
		webToken,
		[]byte(`{"status":"active"}`),
	)
	if enableResp.Code != http.StatusOK {
		t.Fatalf("enable status = %d, body = %s", enableResp.Code, enableResp.Body.String())
	}

	listResp := tokenHTTPResponse(t, srv, http.MethodGet, "/v1/tokens?type=client", webToken, nil)
	if listResp.Code != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", listResp.Code, listResp.Body.String())
	}
	var listed struct {
		Items []map[string]interface{} `json:"items"`
	}
	if err := json.Unmarshal(listResp.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Items) != 1 || listed.Items[0]["last_used_ip"] != "198.51.100.24" {
		t.Fatalf("list response = %#v", listed.Items)
	}

	revokeResp := tokenHTTPResponse(t, srv, http.MethodDelete, "/v1/tokens/"+tokenID, webToken, nil)
	if revokeResp.Code != http.StatusNoContent {
		t.Fatalf("revoke status = %d, body = %s", revokeResp.Code, revokeResp.Body.String())
	}
	listResp = tokenHTTPResponse(t, srv, http.MethodGet, "/v1/tokens?type=client", webToken, nil)
	if listResp.Code != http.StatusOK {
		t.Fatalf("list after revoke status = %d, body = %s", listResp.Code, listResp.Body.String())
	}
	if err := json.Unmarshal(listResp.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Items) != 1 || listed.Items[0]["status"] != "revoked" {
		t.Fatalf("revoked list response = %#v", listed.Items)
	}
}
