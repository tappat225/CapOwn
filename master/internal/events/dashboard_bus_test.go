package events

import (
	"sync"
	"testing"
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
