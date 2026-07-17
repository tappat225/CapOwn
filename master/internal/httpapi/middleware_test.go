package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCORSMiddlewareAllowsAnyOriginWithEmptyAllowlist(t *testing.T) {
	handler := CORSMiddleware(nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/v1/meta", nil)
	req.Header.Set("Origin", "http://dashboard.example.test:3000")
	resp := httptest.NewRecorder()

	handler.ServeHTTP(resp, req)

	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", resp.Code, http.StatusOK)
	}
	if got := resp.Header().Get("Access-Control-Allow-Origin"); got != req.Header.Get("Origin") {
		t.Fatalf("allow-origin = %q, want %q", got, req.Header.Get("Origin"))
	}
}

func TestCORSMiddlewareKeepsExactMatchingWhenAllowlistConfigured(t *testing.T) {
	handler := CORSMiddleware([]string{"http://allowed.example.test:3000"})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	tests := []struct {
		name            string
		origin          string
		wantAllowOrigin string
	}{
		{
			name:            "allowed origin",
			origin:          "http://allowed.example.test:3000",
			wantAllowOrigin: "http://allowed.example.test:3000",
		},
		{
			name:            "unlisted origin",
			origin:          "http://other.example.test:3000",
			wantAllowOrigin: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/v1/meta", nil)
			req.Header.Set("Origin", tt.origin)
			resp := httptest.NewRecorder()

			handler.ServeHTTP(resp, req)

			if got := resp.Header().Get("Access-Control-Allow-Origin"); got != tt.wantAllowOrigin {
				t.Fatalf("allow-origin = %q, want %q", got, tt.wantAllowOrigin)
			}
		})
	}
}

func TestCORSMiddlewareAllowsPreflightInOpenMode(t *testing.T) {
	handler := CORSMiddleware([]string{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("preflight should be handled by CORS middleware")
	}))
	req := httptest.NewRequest(http.MethodOptions, "/v1/auth/login", nil)
	req.Header.Set("Origin", "http://dashboard.example.test:3000")
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	req.Header.Set("Access-Control-Request-Headers", "Authorization, Content-Type")
	resp := httptest.NewRecorder()

	handler.ServeHTTP(resp, req)

	if resp.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", resp.Code, http.StatusNoContent)
	}
	if got := resp.Header().Get("Access-Control-Allow-Origin"); got != req.Header.Get("Origin") {
		t.Fatalf("allow-origin = %q, want %q", got, req.Header.Get("Origin"))
	}
}
