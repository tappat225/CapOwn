package tasks

import (
	"sync"
	"time"

	"github.com/capown/master/internal/domain"
)

// SSEEventData is the data pushed to the Worker via SSE for task dispatch.
type SSEEventData struct {
	TaskID        string      `json:"task_id"`
	TaskType      string      `json:"task_type"`
	Params        interface{} `json:"params"`
	TimeoutSecond int         `json:"timeout_seconds"`
}

// Store provides in-memory task storage with result correlation.
type Store struct {
	mu      sync.RWMutex
	tasks   map[string]*domain.Task
	pending map[string]chan *domain.TaskResult
}

// NewStore creates a new task store.
func NewStore() *Store {
	return &Store{
		tasks:   make(map[string]*domain.Task),
		pending: make(map[string]chan *domain.TaskResult),
	}
}

// Create stores a new task.
func (ts *Store) Create(task *domain.Task) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	ts.tasks[task.TaskID] = cloneTask(task)
}

// Get retrieves a task by ID.
func (ts *Store) Get(taskID string) *domain.Task {
	ts.mu.RLock()
	defer ts.mu.RUnlock()
	return cloneTask(ts.tasks[taskID])
}

// UpdateStatus updates a task's status and timestamps.
func (ts *Store) UpdateStatus(taskID string, status domain.TaskStatus) *domain.Task {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	t, ok := ts.tasks[taskID]
	if !ok {
		return nil
	}
	t.Status = status
	now := domain.NowISO()
	switch status {
	case domain.TaskRunning:
		if t.StartedAt == nil {
			t.StartedAt = &now
		}
	case domain.TaskCompleted, domain.TaskFailed, domain.TaskTimeout, domain.TaskCanceled:
		t.CompletedAt = &now
	}
	return cloneTask(t)
}

// ApplyResult validates and atomically applies a Worker result.
func (ts *Store) ApplyResult(taskID, workerID string, result *domain.TaskResult) (*domain.Task, string) {
	ts.mu.Lock()
	defer ts.mu.Unlock()

	t, ok := ts.tasks[taskID]
	if !ok {
		return nil, "not_found"
	}
	if t.TargetWorker != workerID {
		return nil, "wrong_worker"
	}
	if isTerminal(t.Status) {
		return nil, "terminal"
	}

	switch result.Status {
	case domain.TaskRunning:
		if t.Status != domain.TaskPending {
			return nil, "invalid_transition"
		}
	case domain.TaskCompleted, domain.TaskFailed, domain.TaskTimeout, domain.TaskCanceled:
		if t.Status != domain.TaskPending && t.Status != domain.TaskRunning {
			return nil, "invalid_transition"
		}
	default:
		return nil, "invalid_status"
	}

	t.Status = result.Status
	t.Result = result.Result
	t.Error = result.Error
	t.Truncated = result.Truncated
	if result.StartedAt != nil {
		t.StartedAt = result.StartedAt
	}
	if result.CompletedAt != nil {
		t.CompletedAt = result.CompletedAt
	} else if isTerminal(result.Status) {
		now := domain.NowISO()
		t.CompletedAt = &now
	}

	if isTerminal(result.Status) {
		if ch, ok := ts.pending[taskID]; ok {
			select {
			case ch <- result:
			default:
			}
		}
	}
	return cloneTask(t), ""
}

// Delete removes a task and any pending waiter.
func (ts *Store) Delete(taskID string) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	delete(ts.tasks, taskID)
	delete(ts.pending, taskID)
}

// MarkCanceled transitions an active task to canceled atomically.
func (ts *Store) MarkCanceled(taskID string) *domain.Task {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	t, ok := ts.tasks[taskID]
	if !ok || isTerminal(t.Status) {
		return cloneTask(t)
	}
	t.Status = domain.TaskCanceled
	now := domain.NowISO()
	t.CompletedAt = &now
	return cloneTask(t)
}

func isTerminal(status domain.TaskStatus) bool {
	switch status {
	case domain.TaskCompleted, domain.TaskFailed, domain.TaskTimeout, domain.TaskCanceled:
		return true
	default:
		return false
	}
}

func cloneTask(task *domain.Task) *domain.Task {
	if task == nil {
		return nil
	}
	clone := *task
	return &clone
}

// RegisterPending registers a result channel for a task (used by sync wait).
func (ts *Store) RegisterPending(taskID string) chan *domain.TaskResult {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	ch := make(chan *domain.TaskResult, 1)
	ts.pending[taskID] = ch
	return ch
}

// UnregisterPending removes a pending wait channel.
func (ts *Store) UnregisterPending(taskID string) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	delete(ts.pending, taskID)
}

// WaitForResult blocks on a previously registered channel until a result
// arrives or timeout expires.
// Returns the result, or nil on timeout.
func (ts *Store) WaitForResult(ch <-chan *domain.TaskResult, timeout time.Duration) *domain.TaskResult {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case result := <-ch:
		return result
	case <-timer.C:
		return nil
	}
}

// SSEEventDataForTask creates the SSE event data to push to the Worker.
func SSEEventDataForTask(t *domain.Task) *SSEEventData {
	return &SSEEventData{
		TaskID:        t.TaskID,
		TaskType:      t.TaskType,
		Params:        t.Params,
		TimeoutSecond: t.TimeoutSecond,
	}
}
