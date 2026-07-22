package httpapi

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/capown/master/internal/config"
)

func TestWorkerListScopesByEndpoint(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.Master.DBPath = filepath.Join(t.TempDir(), "master.db")
	srv, err := NewServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = srv.store.Close() })

	adminID, adminToken, _, err := srv.store.RegisterFirstUser(
		"admin",
		"password123",
		3600,
	)
	if err != nil {
		t.Fatal(err)
	}
	user, err := srv.store.CreateUser("alice", "user")
	if err != nil {
		t.Fatal(err)
	}
	userToken, _, _, err := srv.store.CreateSessionToken(user.UserID, 3600)
	if err != nil {
		t.Fatal(err)
	}

	for _, worker := range []struct {
		id      string
		name    string
		ownerID string
	}{
		{id: "wrk_admin_worker", name: "admin-worker", ownerID: adminID},
		{id: "wrk_user_worker", name: "user-worker", ownerID: user.UserID},
	} {
		if err := srv.store.RegisterWorker(
			worker.id,
			worker.name,
			worker.ownerID,
			"host",
			"public-key",
			"linux",
			"stdio",
			"",
			"",
		); err != nil {
			t.Fatal(err)
		}
	}

	ownedResp := tokenHTTPResponse(
		t,
		srv,
		http.MethodGet,
		"/v1/workers",
		adminToken,
		nil,
	)
	if ownedResp.Code != http.StatusOK {
		t.Fatalf("owned worker list status = %d, body=%s", ownedResp.Code, ownedResp.Body.String())
	}
	var owned workerListResponse
	if err := json.Unmarshal(ownedResp.Body.Bytes(), &owned); err != nil {
		t.Fatal(err)
	}
	if owned.Total != 1 || len(owned.Items) != 1 || owned.Items[0].OwnerUserID != adminID {
		t.Fatalf("owned worker list = %#v", owned)
	}

	adminResp := tokenHTTPResponse(
		t,
		srv,
		http.MethodGet,
		"/v1/admin/workers",
		adminToken,
		nil,
	)
	if adminResp.Code != http.StatusOK {
		t.Fatalf("admin worker list status = %d, body=%s", adminResp.Code, adminResp.Body.String())
	}
	var all workerListResponse
	if err := json.Unmarshal(adminResp.Body.Bytes(), &all); err != nil {
		t.Fatal(err)
	}
	if all.Total != 2 || len(all.Items) != 2 {
		t.Fatalf("admin worker list = %#v", all)
	}

	forbiddenResp := tokenHTTPResponse(
		t,
		srv,
		http.MethodGet,
		"/v1/admin/workers",
		userToken,
		nil,
	)
	if forbiddenResp.Code != http.StatusForbidden {
		t.Fatalf("non-admin worker list status = %d, body=%s", forbiddenResp.Code, forbiddenResp.Body.String())
	}
}
