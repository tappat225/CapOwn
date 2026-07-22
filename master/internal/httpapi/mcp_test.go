// SPDX-License-Identifier: Apache-2.0

package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/capown/master/internal/config"
	"github.com/capown/master/internal/domain"
)

func newMCPTestServer(t *testing.T, publicURL string) (*Server, string, string) {
	t.Helper()
	cfg := config.DefaultConfig()
	cfg.Master.DBPath = filepath.Join(t.TempDir(), "master.db")
	cfg.Master.PublicURL = publicURL

	srv, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = srv.store.Close() })

	user, err := srv.store.CreateUser("alice", "user")
	if err != nil {
		t.Fatal(err)
	}
	clientToken, _, err := srv.store.CreateToken(user.UserID, "client", "mcp-test")
	if err != nil {
		t.Fatal(err)
	}
	return srv, user.UserID, clientToken
}

func mcpTestRequest(t *testing.T, srv *Server, token string, method string, id interface{}, params interface{}, ctx context.Context) *httptest.ResponseRecorder {
	t.Helper()
	payload := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
	}
	if params != nil {
		payload["params"] = params
	}
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(body))
	if ctx != nil {
		req = req.WithContext(ctx)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(resp, req)
	return resp
}

func decodeMCPTestBody(t *testing.T, resp *httptest.ResponseRecorder) map[string]interface{} {
	t.Helper()
	var body map[string]interface{}
	if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode MCP response: %v; body=%s", err, resp.Body.String())
	}
	return body
}

func mcpTextResult(t *testing.T, body map[string]interface{}) string {
	t.Helper()
	result, ok := body["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("MCP response has no result: %#v", body)
	}
	content, ok := result["content"].([]interface{})
	if !ok || len(content) == 0 {
		t.Fatalf("MCP result has no content: %#v", result)
	}
	block, ok := content[0].(map[string]interface{})
	if !ok {
		t.Fatalf("invalid MCP content block: %#v", content[0])
	}
	text, ok := block["text"].(string)
	if !ok {
		t.Fatalf("MCP content block has no text: %#v", block)
	}
	return text
}

func TestMCPPluginResultPreservesRichContent(t *testing.T) {
	emptyText := ""
	task := &domain.Task{
		Result: &domain.PluginCallResult{
			Content: []domain.ContentBlock{
				{Type: "image", Data: "aW1hZ2U=", MIMEType: "image/png"},
				{Type: "audio", Data: "YXVkaW8=", MIMEType: "audio/wav"},
				{Type: "resource", Resource: &domain.ResourceContent{
					URI: "file:///tmp/example.txt", MIMEType: "text/plain", Text: &emptyText,
				}},
			},
		},
	}

	result := mcpPluginResult(task)
	if len(result.Content) != 3 {
		t.Fatalf("rich content count = %d, want 3", len(result.Content))
	}
	if result.Content[0].Type != "image" || result.Content[0].Data != "aW1hZ2U=" || result.Content[0].MimeType != "image/png" {
		t.Fatalf("unexpected image content: %#v", result.Content[0])
	}
	if result.Content[1].Type != "audio" || result.Content[1].Data != "YXVkaW8=" || result.Content[1].MimeType != "audio/wav" {
		t.Fatalf("unexpected audio content: %#v", result.Content[1])
	}
	resource := result.Content[2].Resource
	if resource == nil || resource.URI != "file:///tmp/example.txt" || resource.MimeType != "text/plain" || resource.Text == nil || *resource.Text != "" {
		t.Fatalf("unexpected resource content: %#v", resource)
	}

	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte(`"mimeType":"image/png"`)) || bytes.Contains(raw, []byte(`"mime_type"`)) {
		t.Fatalf("MCP content has incorrect field names: %s", raw)
	}
}

func TestValidPluginContentBlock(t *testing.T) {
	text := "text"
	blob := "blob"
	tests := []struct {
		name  string
		block domain.ContentBlock
		valid bool
	}{
		{name: "image", block: domain.ContentBlock{Type: "image", MIMEType: "image/png"}, valid: true},
		{name: "audio", block: domain.ContentBlock{Type: "audio", MIMEType: "audio/wav"}, valid: true},
		{name: "image without mime type", block: domain.ContentBlock{Type: "image"}},
		{name: "resource text", block: domain.ContentBlock{Type: "resource", Resource: &domain.ResourceContent{URI: "file:///tmp/a.txt", Text: &text}}, valid: true},
		{name: "resource blob", block: domain.ContentBlock{Type: "resource", Resource: &domain.ResourceContent{URI: "file:///tmp/a.bin", Blob: &blob}}, valid: true},
		{name: "resource without content", block: domain.ContentBlock{Type: "resource", Resource: &domain.ResourceContent{URI: "file:///tmp/a.txt"}}},
		{name: "resource with both content forms", block: domain.ContentBlock{Type: "resource", Resource: &domain.ResourceContent{URI: "file:///tmp/a.txt", Text: &text, Blob: &blob}}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := validPluginContentBlock(tt.block); got != tt.valid {
				t.Fatalf("validPluginContentBlock() = %v, want %v", got, tt.valid)
			}
		})
	}
}

func TestMCPInitializeAndToolsList(t *testing.T) {
	srv, _, token := newMCPTestServer(t, "")

	initResp := mcpTestRequest(t, srv, token, "initialize", 1, map[string]interface{}{
		"protocolVersion": "2025-03-26",
	}, nil)
	if initResp.Code != http.StatusOK {
		t.Fatalf("initialize status = %d, body=%s", initResp.Code, initResp.Body.String())
	}
	initBody := decodeMCPTestBody(t, initResp)
	initResult := initBody["result"].(map[string]interface{})
	if initResult["protocolVersion"] != mcpProtocolVersion {
		t.Fatalf("unexpected protocol version: %#v", initResult["protocolVersion"])
	}

	listResp := mcpTestRequest(t, srv, token, "tools/list", 2, map[string]interface{}{}, nil)
	if listResp.Code != http.StatusOK {
		t.Fatalf("tools/list status = %d, body=%s", listResp.Code, listResp.Body.String())
	}
	listBody := decodeMCPTestBody(t, listResp)
	listResult := listBody["result"].(map[string]interface{})
	tools, ok := listResult["tools"].([]interface{})
	if !ok {
		t.Fatalf("tools/list returned no tools: %#v", listResult)
	}
	wanted := map[string]bool{
		"workers_list": false,
		"worker_get":   false,
		"plugin_list":  false,
		"plugin_call":  false,
		"task_get":     false,
		"task_wait":    false,
		"task_cancel":  false,
	}
	for _, raw := range tools {
		tool := raw.(map[string]interface{})
		name, _ := tool["name"].(string)
		if _, exists := wanted[name]; exists {
			wanted[name] = true
		}
		if _, exists := tool["inputSchema"]; !exists {
			t.Fatalf("tool %q has no inputSchema", name)
		}
	}
	for name, found := range wanted {
		if !found {
			t.Errorf("tools/list is missing %q", name)
		}
	}
}

func TestMCPAuthenticationAndTransportChecks(t *testing.T) {
	srv, userID, token := newMCPTestServer(t, "http://localhost:9230")
	adminToken, _, err := srv.store.CreateToken(userID, "admin", "admin-token")
	if err != nil {
		t.Fatal(err)
	}

	missingAuth := mcpTestRequest(t, srv, "", "ping", 1, map[string]interface{}{}, nil)
	if missingAuth.Code != http.StatusUnauthorized {
		t.Fatalf("missing auth status = %d, body=%s", missingAuth.Code, missingAuth.Body.String())
	}

	admin := mcpTestRequest(t, srv, adminToken, "ping", 2, map[string]interface{}{}, nil)
	if admin.Code != http.StatusForbidden {
		t.Fatalf("admin token status = %d, body=%s", admin.Code, admin.Body.String())
	}

	wrongOriginReq := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader([]byte(`{"jsonrpc":"2.0","id":3,"method":"ping"}`)))
	wrongOriginReq.Header.Set("Authorization", "Bearer "+token)
	wrongOriginReq.Header.Set("Content-Type", "application/json")
	wrongOriginReq.Header.Set("Accept", "application/json, text/event-stream")
	wrongOriginReq.Header.Set("Origin", "http://evil.example")
	wrongOriginResp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(wrongOriginResp, wrongOriginReq)
	if wrongOriginResp.Code != http.StatusForbidden {
		t.Fatalf("wrong Origin status = %d, body=%s", wrongOriginResp.Code, wrongOriginResp.Body.String())
	}

	missingAcceptReq := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader([]byte(`{"jsonrpc":"2.0","id":4,"method":"ping"}`)))
	missingAcceptReq.Header.Set("Authorization", "Bearer "+token)
	missingAcceptReq.Header.Set("Content-Type", "application/json")
	missingAcceptResp := httptest.NewRecorder()
	srv.Handler().ServeHTTP(missingAcceptResp, missingAcceptReq)
	if missingAcceptResp.Code != http.StatusNotAcceptable {
		t.Fatalf("missing Accept status = %d, body=%s", missingAcceptResp.Code, missingAcceptResp.Body.String())
	}
}

func TestMCPPluginDispatchAndTaskLifecycle(t *testing.T) {
	srv, userID, token := newMCPTestServer(t, "")
	workerID := "wrk_000000000000000000000001"
	if err := srv.store.RegisterWorker(workerID, "worker-one", userID, "host", "public-key", "linux", "capability", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, _, err := srv.store.ReconnectWorker(workerID, "host", "linux", "capability", "", "", "[]"); err != nil {
		t.Fatal(err)
	}

	workersResp := mcpTestRequest(t, srv, token, "tools/call", 1, map[string]interface{}{
		"name":      "workers_list",
		"arguments": map[string]interface{}{},
		"_meta":     map[string]interface{}{"source": "test"},
	}, nil)
	if workersResp.Code != http.StatusOK {
		t.Fatalf("workers_list status = %d, body=%s", workersResp.Code, workersResp.Body.String())
	}
	var workers workerListResponse
	if err := json.Unmarshal([]byte(mcpTextResult(t, decodeMCPTestBody(t, workersResp))), &workers); err != nil {
		t.Fatal(err)
	}
	if workers.Total != 1 || len(workers.Items) != 1 || workers.Items[0].WorkerID != workerID {
		t.Fatalf("unexpected Worker list: %#v", workers)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	pluginResp := mcpTestRequest(t, srv, token, "tools/call", 2, map[string]interface{}{
		"name": "plugin_call",
		"arguments": map[string]interface{}{
			"worker":          "worker-one",
			"plugin_id":       "example",
			"tool_name":       "echo",
			"arguments":       map[string]interface{}{"value": "hello"},
			"timeout_seconds": 1,
		},
	}, ctx)
	if pluginResp.Code != http.StatusOK {
		t.Fatalf("plugin_call status = %d, body=%s", pluginResp.Code, pluginResp.Body.String())
	}
	var pending taskResponse
	if err := json.Unmarshal([]byte(mcpTextResult(t, decodeMCPTestBody(t, pluginResp))), &pending); err != nil {
		t.Fatal(err)
	}
	if pending.TaskID == "" || pending.Status != "pending" {
		t.Fatalf("plugin_call did not return pending task: %#v", pending)
	}

	cancelResp := mcpTestRequest(t, srv, token, "tools/call", 3, map[string]interface{}{
		"name":      "task_cancel",
		"arguments": map[string]interface{}{"task_id": pending.TaskID},
	}, nil)
	if cancelResp.Code != http.StatusOK {
		t.Fatalf("task_cancel status = %d, body=%s", cancelResp.Code, cancelResp.Body.String())
	}
	var canceled taskResponse
	if err := json.Unmarshal([]byte(mcpTextResult(t, decodeMCPTestBody(t, cancelResp))), &canceled); err != nil {
		t.Fatal(err)
	}
	if canceled.Status != "canceled" {
		t.Fatalf("task_cancel status = %q, want canceled", canceled.Status)
	}
}
