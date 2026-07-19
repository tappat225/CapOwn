package httpapi

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/capown/master/internal/config"
)

func newDashboardEventTestServer(t *testing.T) (*Server, string) {
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
	token, _, _, err := srv.store.CreateSessionToken(user.UserID, 60)
	if err != nil {
		t.Fatal(err)
	}
	return srv, token
}

func TestDashboardEventsFlushesConnectedCommentImmediately(t *testing.T) {
	srv, token := newDashboardEventTestServer(t)
	httpServer := httptest.NewServer(srv.Handler())
	t.Cleanup(httpServer.Close)

	req, err := http.NewRequest(http.MethodGet, httpServer.URL+"/v1/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	line, err := bufio.NewReader(resp.Body).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if line != ": connected\n" {
		t.Fatalf("initial SSE line = %q, want connected comment", line)
	}
}

func TestDashboardEventsEndsWhenMasterShutsDown(t *testing.T) {
	srv, token := newDashboardEventTestServer(t)
	httpServer := httptest.NewServer(srv.Handler())
	t.Cleanup(httpServer.Close)

	req, err := http.NewRequest(http.MethodGet, httpServer.URL+"/v1/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	reader := bufio.NewReader(resp.Body)
	if _, err := reader.ReadString('\n'); err != nil {
		t.Fatal(err)
	}

	srv.signalShutdown()
	done := make(chan error, 1)
	go func() {
		_, err := io.ReadAll(reader)
		done <- err
	}()

	select {
	case err := <-done:
		if err != nil && err != context.Canceled {
			t.Fatalf("read stream after shutdown: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("dashboard event stream did not end after shutdown")
	}
}
