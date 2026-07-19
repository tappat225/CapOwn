package events

import (
	"sync"
	"testing"
	"time"
)

func TestEvictedSubscriberCanUnsubscribe(t *testing.T) {
	bus := NewDashboardBus(8, 1)
	first := bus.Subscribe("user-1", "")
	second := bus.Subscribe("user-1", "")

	if _, ok := <-first; ok {
		t.Fatal("evicted subscriber channel should be closed")
	}
	bus.Unsubscribe("user-1", first)
	bus.Unsubscribe("user-1", second)
}

func TestPublishWorkerReachesOwnerAndAdmin(t *testing.T) {
	bus := NewDashboardBus(8, 4)
	owner := bus.Subscribe("user-1", "")
	other := bus.Subscribe("user-2", "")
	admin := bus.Subscribe(AdminGlobalScope, "")

	bus.PublishWorker("user-1", "worker.plugins_updated", map[string]string{"worker_id": "wrk_test"})

	for name, ch := range map[string]chan DashboardEvent{"owner": owner, "admin": admin} {
		select {
		case event := <-ch:
			if event.Event != "worker.plugins_updated" {
				t.Fatalf("%s received %q", name, event.Event)
			}
		case <-time.After(time.Second):
			t.Fatalf("%s did not receive the event", name)
		}
	}
	select {
	case event := <-other:
		t.Fatalf("other user received %#v", event)
	default:
	}
}

func TestCloseScopeDisconnectsSubscribers(t *testing.T) {
	bus := NewDashboardBus(8, 4)
	ch := bus.Subscribe("user-1", "")
	bus.CloseScope("user-1")
	if _, ok := <-ch; ok {
		t.Fatal("closed scope subscriber should be closed")
	}
}

func TestConcurrentPublishAndSubscribe(t *testing.T) {
	bus := NewDashboardBus(32, 4)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			ch := bus.Subscribe("user-1", "")
			bus.Unsubscribe("user-1", ch)
		}()
		go func() {
			defer wg.Done()
			bus.Publish("user-1", "worker.online", map[string]string{"worker_id": "wrk_test"})
		}()
	}
	wg.Wait()
}
