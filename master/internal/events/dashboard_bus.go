package events

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// DashboardEvent represents an event for dashboard SSE.
type DashboardEvent struct {
	ID    string      `json:"id"`
	Event string      `json:"event"`
	Data  interface{} `json:"data"`
}

// DashboardBus manages user-scoped event subscriptions for dashboard SSE.
type DashboardBus struct {
	mu          sync.RWMutex
	subscribers map[string][]chan DashboardEvent
	history     map[string][]DashboardEvent
	sequence    int64
	maxHistory  int
	maxSubs     int
}

// NewDashboardBus creates a new DashboardBus.
func NewDashboardBus(maxHistory, maxSubscribers int) *DashboardBus {
	return &DashboardBus{
		subscribers: make(map[string][]chan DashboardEvent),
		history:     make(map[string][]DashboardEvent),
		maxHistory:  maxHistory,
		maxSubs:     maxSubscribers,
	}
}

// Subscribe creates a new subscription for a user.
// lastEventID is used for replay; if empty, the latest event is the starting point.
func (b *DashboardBus) Subscribe(userID, lastEventID string) chan DashboardEvent {
	b.mu.Lock()
	defer b.mu.Unlock()

	ch := make(chan DashboardEvent, 64)

	// Enforce max subscribers per user
	subs := b.subscribers[userID]
	if len(subs) >= b.maxSubs {
		// Remove oldest subscriber
		close(subs[0])
		subs = subs[1:]
	}
	b.subscribers[userID] = append(subs, ch)

	// Replay history if lastEventID provided
	if lastEventID != "" {
		history := b.history[userID]
		found := false
		for _, evt := range history {
			if evt.ID == lastEventID {
				found = true
				continue
			}
			if found {
				ch <- evt
			}
		}
		if !found {
			ch <- DashboardEvent{
				ID:    fmt.Sprintf("%d", time.Now().UnixNano()),
				Event: "resync",
				Data:  map[string]string{"message": "last event not found, resyncing"},
			}
		}
	}

	return ch
}

// Unsubscribe removes a subscription.
func (b *DashboardBus) Unsubscribe(userID string, queue chan DashboardEvent) {
	b.mu.Lock()
	defer b.mu.Unlock()

	subs := b.subscribers[userID]
	for i, ch := range subs {
		if ch == queue {
			close(ch)
			b.subscribers[userID] = append(subs[:i], subs[i+1:]...)
			return
		}
	}
	// The queue may already have been evicted and closed by Subscribe.
}

// Publish sends an event to all subscribers of a user.
func (b *DashboardBus) Publish(userID, event string, data interface{}) {
	b.mu.Lock()

	b.sequence++
	id := fmt.Sprintf("%d", b.sequence)
	evt := DashboardEvent{
		ID:    id,
		Event: event,
		Data:  data,
	}

	// Add to history
	b.history[userID] = append(b.history[userID], evt)
	if len(b.history[userID]) > b.maxHistory {
		b.history[userID] = b.history[userID][1:]
	}

	// Send while holding the lock so Unsubscribe cannot close a channel
	// between selecting it and sending to it. Sends are non-blocking.
	for _, ch := range b.subscribers[userID] {
		select {
		case ch <- evt:
		default:
		}
	}
	b.mu.Unlock()
}

// PublishByWorker looks up the owner of a worker and publishes to that user.
func (b *DashboardBus) PublishByWorker(workerID, event string, data interface{}, ownerFn func(workerID string) (string, error)) {
	userID, err := ownerFn(workerID)
	if err != nil || userID == "" {
		return
	}
	b.Publish(userID, event, data)
}

// MarshalDashboardEvent formats a DashboardEvent as SSE text.
func MarshalDashboardEvent(evt DashboardEvent) string {
	jsonData, _ := json.Marshal(evt.Data)
	return fmt.Sprintf("id: %s\nevent: %s\ndata: %s\n\n", evt.ID, evt.Event, string(jsonData))
}

// MarshalPing returns a dashboard SSE ping.
func MarshalPing() string {
	return ": ping\n\n"
}
