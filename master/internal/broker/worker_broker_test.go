package broker

import (
	"sync"
	"testing"
)

func TestReplacementDoesNotDisconnectNewQueue(t *testing.T) {
	broker := NewWorkerBroker(4, 4)
	oldQueue, oldGen := broker.Connect("wrk_test")
	newQueue, newGen := broker.Connect("wrk_test")

	if _, ok := <-oldQueue; ok {
		t.Fatal("replaced queue should be closed")
	}
	if broker.Disconnect("wrk_test", oldQueue, oldGen) {
		t.Fatal("stale disconnect must not remove the new queue")
	}
	if !broker.Push("wrk_test", "ping", nil) {
		t.Fatal("new queue should remain connected")
	}
	<-newQueue
	if !broker.Disconnect("wrk_test", newQueue, newGen) {
		t.Fatal("current disconnect should succeed")
	}
}

func TestConcurrentPushAndDisconnect(t *testing.T) {
	for i := 0; i < 100; i++ {
		broker := NewWorkerBroker(2, 1)
		queue, gen := broker.Connect("wrk_test")
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			broker.Push("wrk_test", "ping", nil)
		}()
		go func() {
			defer wg.Done()
			broker.Disconnect("wrk_test", queue, gen)
		}()
		wg.Wait()
	}
}
