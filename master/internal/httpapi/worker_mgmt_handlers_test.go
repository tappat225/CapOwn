package httpapi

import (
	"database/sql"
	"testing"

	"github.com/capown/master/internal/store"
)

func TestWorkerListItemIncludesOwnerAndEmptyPlugins(t *testing.T) {
	item := workerListItemFromRow(&store.WorkerRow{
		WorkerID:    "wrk_test",
		WorkerName:  "worker",
		OwnerUserID: "usr_test",
		Plugins:     sql.NullString{},
	}, "alice")
	if item.OwnerUserID != "usr_test" || item.OwnerUsername != "alice" {
		t.Fatalf("unexpected owner: %#v", item)
	}
	if item.Plugins == nil || len(item.Plugins) != 0 {
		t.Fatalf("plugins must be an empty array: %#v", item.Plugins)
	}
}
