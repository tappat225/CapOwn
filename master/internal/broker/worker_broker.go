package broker

import (
	"encoding/json"
	"sync"
)

// SSEEvent represents an event to be sent over SSE.
type SSEEvent struct {
	Event string      `json:"event"`
	Data  interface{} `json:"data"`
}

// WorkerBroker manages per-worker SSE event channels.
type WorkerBroker struct {
	mu      sync.RWMutex
	queues  map[string]chan SSEEvent
	nextGen map[string]int
	maxQ    int
	cap     int
}

// NewWorkerBroker creates a new WorkerBroker with max queue limit.
func NewWorkerBroker(maxQueues, channelCap int) *WorkerBroker {
	return &WorkerBroker{
		queues:  make(map[string]chan SSEEvent),
		nextGen: make(map[string]int),
		maxQ:    maxQueues,
		cap:     channelCap,
	}
}

// Connect creates or replaces a worker's event channel.
// Returns the channel and a generation counter.
func (b *WorkerBroker) Connect(workerID string) (chan SSEEvent, int) {
	b.mu.Lock()
	defer b.mu.Unlock()

	// Close old channel if exists — causes the old SSE handler to exit naturally
	if oldCh, ok := b.queues[workerID]; ok {
		close(oldCh)
	}

	// Enforce max queue limit
	if len(b.queues) >= b.maxQ {
		// Evict one worker (just don't add more)
		for id := range b.queues {
			if id != workerID {
				close(b.queues[id])
				delete(b.queues, id)
				delete(b.nextGen, id)
				break
			}
		}
	}

	gen := b.nextGen[workerID] + 1
	b.nextGen[workerID] = gen
	ch := make(chan SSEEvent, b.cap)
	b.queues[workerID] = ch
	return ch, gen
}

// Disconnect removes a worker's channel if its generation matches.
func (b *WorkerBroker) Disconnect(workerID string, queue chan SSEEvent, gen int) bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.nextGen[workerID] != gen {
		return false // stale disconnect
	}
	if b.queues[workerID] == queue {
		close(queue)
		delete(b.queues, workerID)
		delete(b.nextGen, workerID)
		return true
	}
	return false
}

// DrainAndClose forcefully closes and removes a worker's channel.
func (b *WorkerBroker) DrainAndClose(workerID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	ch, ok := b.queues[workerID]
	if !ok {
		return false
	}
	close(ch)
	delete(b.queues, workerID)
	delete(b.nextGen, workerID)
	return true
}

// IsConnected checks if a worker has an active channel.
func (b *WorkerBroker) IsConnected(workerID string) bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	_, ok := b.queues[workerID]
	return ok
}

// ConnectedWorkers returns the list of connected worker IDs.
func (b *WorkerBroker) ConnectedWorkers() []string {
	b.mu.RLock()
	defer b.mu.RUnlock()

	ids := make([]string, 0, len(b.queues))
	for id := range b.queues {
		ids = append(ids, id)
	}
	return ids
}

// Push sends an event to a worker's channel. Returns false if channel is full or worker not connected.
func (b *WorkerBroker) Push(workerID string, event string, data interface{}) bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	ch, ok := b.queues[workerID]
	if !ok {
		return false
	}

	select {
	case ch <- SSEEvent{Event: event, Data: data}:
		return true
	default:
		return false // queue full
	}
}

// MarshalSSE formats an SSEEvent as a string for the wire.
func MarshalSSE(event string, data interface{}) string {
	jsonData, _ := json.Marshal(data)
	return "event: " + event + "\ndata: " + string(jsonData) + "\n\n"
}

// MarshalPing returns a ping SSE comment.
func MarshalPing() string {
	return ": ping\n\n"
}
