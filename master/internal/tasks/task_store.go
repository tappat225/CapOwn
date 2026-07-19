// SPDX-License-Identifier: Apache-2.0

package tasks

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"

	"github.com/capown/master/internal/domain"
)

// JobType identifies a claimable worker job.
type JobType string

const (
	JobTypeTask   JobType = "task"
	JobTypeCancel JobType = "cancel"

	defaultDeliveryLease = 10 * time.Second
)

type deliveryLease struct {
	deliveryID string
	workerID   string
	expiresAt  time.Time
}

// WorkerJob is returned by the claim API.
type WorkerJob struct {
	JobType       JobType     `json:"job_type"`
	DeliveryID    string      `json:"delivery_id"`
	TaskID        string      `json:"task_id"`
	TaskType      string      `json:"task_type,omitempty"`
	Params        interface{} `json:"params,omitempty"`
	TimeoutSecond int         `json:"timeout_seconds,omitempty"`
}

// WakeData is the optional SSE wake payload.
type WakeData struct {
	Reason string `json:"reason"`
}

// Store provides in-memory task storage with claim queues and result correlation.
type Store struct {
	mu             sync.Mutex
	tasks          map[string]*domain.Task
	pending        map[string]chan *domain.TaskResult
	workQueues     map[string][]string // worker_id -> pending task IDs (FIFO)
	cancelQ        map[string][]string // worker_id -> cancel task IDs (FIFO, deduped)
	cancelSet      map[string]map[string]struct{}
	taskLeases     map[string]deliveryLease
	cancelLeases   map[string]deliveryLease
	deliveries     map[string]string
	waiters        map[string][]chan struct{}
	pollers        map[string]int
	blockedWorkers map[string]bool
	leaseDuration  time.Duration
}

// NewStore creates a new task store.
func NewStore() *Store {
	return newStoreWithLeaseDuration(defaultDeliveryLease)
}

func newStoreWithLeaseDuration(leaseDuration time.Duration) *Store {
	return &Store{
		tasks:          make(map[string]*domain.Task),
		pending:        make(map[string]chan *domain.TaskResult),
		workQueues:     make(map[string][]string),
		cancelQ:        make(map[string][]string),
		cancelSet:      make(map[string]map[string]struct{}),
		taskLeases:     make(map[string]deliveryLease),
		cancelLeases:   make(map[string]deliveryLease),
		deliveries:     make(map[string]string),
		waiters:        make(map[string][]chan struct{}),
		pollers:        make(map[string]int),
		blockedWorkers: make(map[string]bool),
		leaseDuration:  leaseDuration,
	}
}

// EnqueuePending stores the task if needed and appends it to the worker work queue.
// The task must be in pending status.
func (ts *Store) EnqueuePending(task *domain.Task) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	ts.tasks[task.TaskID] = cloneTask(task)
	workerID := task.TargetWorker
	ts.workQueues[workerID] = append(ts.workQueues[workerID], task.TaskID)
	ts.signalWaitersLocked(workerID)
}

// Get retrieves a task by ID.
func (ts *Store) Get(taskID string) *domain.Task {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	return cloneTask(ts.tasks[taskID])
}

// ApplyResult validates and atomically applies a Worker result.
func (ts *Store) ApplyResult(taskID, workerID string, result *domain.TaskResult) (*domain.Task, string) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	ts.reapExpiredLocked(time.Now(), workerID)

	t, ok := ts.tasks[taskID]
	if !ok {
		return nil, "not_found"
	}
	if t.TargetWorker != workerID {
		return nil, "wrong_worker"
	}
	if isTerminal(t.Status) {
		if t.Status == result.Status && ts.deliveries[taskID] == result.DeliveryID {
			return cloneTask(t), ""
		}
		return nil, "terminal"
	}

	switch result.Status {
	case domain.TaskRunning:
		if t.Status == domain.TaskPending {
			lease, claimed := ts.taskLeases[taskID]
			if !claimed || lease.workerID != workerID || lease.deliveryID != result.DeliveryID {
				return nil, "invalid_transition"
			}
			delete(ts.taskLeases, taskID)
			ts.deliveries[taskID] = result.DeliveryID
			ts.removeWorkLocked(workerID, taskID)
		} else if t.Status != domain.TaskRunning || ts.deliveries[taskID] != result.DeliveryID {
			return nil, "invalid_transition"
		}
	case domain.TaskCompleted, domain.TaskFailed, domain.TaskTimeout, domain.TaskCanceled:
		if t.Status != domain.TaskRunning || ts.deliveries[taskID] != result.DeliveryID {
			return nil, "invalid_transition"
		}
	default:
		return nil, "invalid_status"
	}

	t.Status = result.Status
	if result.Status != domain.TaskRunning {
		t.Result = result.Result
		t.Error = result.Error
		t.Truncated = result.Truncated
	}
	if result.StartedAt != nil && t.StartedAt == nil {
		t.StartedAt = result.StartedAt
	} else if result.Status == domain.TaskRunning && t.StartedAt == nil {
		now := domain.NowISO()
		t.StartedAt = &now
	}
	if result.CompletedAt != nil {
		t.CompletedAt = result.CompletedAt
	} else if isTerminal(result.Status) {
		now := domain.NowISO()
		t.CompletedAt = &now
	}

	// Drop any outstanding cancel job once the task is terminal.
	if isTerminal(result.Status) {
		delete(ts.taskLeases, taskID)
		delete(ts.cancelLeases, taskID)
		ts.removeCancelLocked(workerID, taskID)
		if ch, ok := ts.pending[taskID]; ok {
			select {
			case ch <- result:
			default:
			}
		}
	}
	return cloneTask(t), ""
}

// CancelPending marks a pending task canceled and removes it from the work queue.
// Returns the task and true when cancellation applied; false when not pending.
func (ts *Store) CancelPending(taskID string) (*domain.Task, bool) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	t, ok := ts.tasks[taskID]
	if !ok {
		return nil, false
	}
	if t.Status != domain.TaskPending {
		return cloneTask(t), false
	}
	t.Status = domain.TaskCanceled
	now := domain.NowISO()
	t.CompletedAt = &now
	delete(ts.taskLeases, taskID)
	delete(ts.deliveries, taskID)
	ts.removeWorkLocked(t.TargetWorker, taskID)
	ts.notifyResultLocked(taskID, &domain.TaskResult{
		TaskID:      taskID,
		WorkerID:    t.TargetWorker,
		Status:      domain.TaskCanceled,
		CompletedAt: &now,
	})
	return cloneTask(t), true
}

// EnqueueCancel queues a cancel job for a running task. Returns false if the
// task is missing, not running, or already terminal.
func (ts *Store) EnqueueCancel(taskID string) (*domain.Task, bool) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	t, ok := ts.tasks[taskID]
	if !ok {
		return nil, false
	}
	if t.Status != domain.TaskRunning {
		return cloneTask(t), false
	}
	workerID := t.TargetWorker
	if _, leased := ts.cancelLeases[taskID]; leased {
		return cloneTask(t), true
	}
	if ts.cancelSet[workerID] == nil {
		ts.cancelSet[workerID] = make(map[string]struct{})
	}
	if _, exists := ts.cancelSet[workerID][taskID]; !exists {
		ts.cancelSet[workerID][taskID] = struct{}{}
		ts.cancelQ[workerID] = append(ts.cancelQ[workerID], taskID)
		ts.signalWaitersLocked(workerID)
	}
	return cloneTask(t), true
}

// Claim reserves up to limit jobs for delivery to a worker. A task remains
// pending until the Worker confirms receipt by reporting running.
func (ts *Store) Claim(workerID string, limit int) []WorkerJob {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	if ts.blockedWorkers[workerID] {
		return []WorkerJob{}
	}
	ts.reapExpiredLocked(time.Now(), workerID)
	if limit < 1 {
		return []WorkerJob{}
	}

	jobs := make([]WorkerJob, 0, limit)

	// Prefer cancel jobs so running work can stop promptly.
	for len(jobs) < limit && len(ts.cancelQ[workerID]) > 0 {
		taskID := ts.cancelQ[workerID][0]
		ts.cancelQ[workerID] = ts.cancelQ[workerID][1:]
		if set := ts.cancelSet[workerID]; set != nil {
			delete(set, taskID)
		}
		t := ts.tasks[taskID]
		if t == nil || t.Status != domain.TaskRunning {
			continue
		}
		if _, leased := ts.cancelLeases[taskID]; leased {
			continue
		}
		deliveryID := generateDeliveryID()
		ts.cancelLeases[taskID] = deliveryLease{
			deliveryID: deliveryID,
			workerID:   workerID,
			expiresAt:  time.Now().Add(ts.leaseDuration),
		}
		jobs = append(jobs, WorkerJob{
			JobType:    JobTypeCancel,
			DeliveryID: deliveryID,
			TaskID:     taskID,
		})
	}

	for len(jobs) < limit && len(ts.workQueues[workerID]) > 0 {
		taskID := ts.workQueues[workerID][0]
		ts.workQueues[workerID] = ts.workQueues[workerID][1:]
		t := ts.tasks[taskID]
		if t == nil || t.Status != domain.TaskPending {
			continue
		}
		if _, leased := ts.taskLeases[taskID]; leased {
			continue
		}
		deliveryID := generateDeliveryID()
		ts.taskLeases[taskID] = deliveryLease{
			deliveryID: deliveryID,
			workerID:   workerID,
			expiresAt:  time.Now().Add(ts.leaseDuration),
		}
		jobs = append(jobs, WorkerJob{
			JobType:       JobTypeTask,
			DeliveryID:    deliveryID,
			TaskID:        t.TaskID,
			TaskType:      t.TaskType,
			Params:        t.Params,
			TimeoutSecond: t.TimeoutSecond,
		})
	}

	if jobs == nil {
		return []WorkerJob{}
	}
	return jobs
}

// ClaimOrWait claims jobs immediately, or waits until jobs arrive, timeout, or ctx cancel.
func (ts *Store) ClaimOrWait(ctx context.Context, workerID string, limit int, wait time.Duration) []WorkerJob {
	if ts.IsWorkerBlocked(workerID) {
		return []WorkerJob{}
	}
	if jobs := ts.Claim(workerID, limit); len(jobs) > 0 || wait <= 0 {
		if jobs == nil {
			return []WorkerJob{}
		}
		return jobs
	}

	deadline := time.Now().Add(wait)
	for {
		if ts.IsWorkerBlocked(workerID) {
			return []WorkerJob{}
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			jobs := ts.Claim(workerID, limit)
			if jobs == nil {
				return []WorkerJob{}
			}
			return jobs
		}

		waitFor := remaining
		if leaseDelay, ok := ts.nextLeaseDelay(workerID); ok && leaseDelay < waitFor {
			waitFor = leaseDelay
		}
		if waitFor <= 0 {
			continue
		}

		notify := ts.addWaiter(workerID)
		timer := time.NewTimer(waitFor)
		select {
		case <-ctx.Done():
			timer.Stop()
			ts.removeWaiter(workerID, notify)
			return []WorkerJob{}
		case <-timer.C:
			ts.removeWaiter(workerID, notify)
			if jobs := ts.Claim(workerID, limit); len(jobs) > 0 {
				return jobs
			}
		case <-notify:
			timer.Stop()
			ts.removeWaiter(workerID, notify)
			if jobs := ts.Claim(workerID, limit); len(jobs) > 0 {
				return jobs
			}
		}
	}
}

// BlockWorker interrupts active claim waits and prevents new claims.
func (ts *Store) BlockWorker(workerID string) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	ts.blockedWorkers[workerID] = true
	ts.signalWaitersLocked(workerID)
}

// UnblockWorker permits claims again after an account is enabled.
func (ts *Store) UnblockWorker(workerID string) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	delete(ts.blockedWorkers, workerID)
}

// IsWorkerBlocked reports whether administrative state prevents job claims.
func (ts *Store) IsWorkerBlocked(workerID string) bool {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	return ts.blockedWorkers[workerID]
}

// RecoverWorker returns non-terminal work owned by a stale Worker to a safe
// state. Running tasks are requeued unless cancellation was already requested.
func (ts *Store) RecoverWorker(workerID string) int {
	ts.mu.Lock()
	defer ts.mu.Unlock()

	recovered := 0
	for taskID, task := range ts.tasks {
		if task.TargetWorker != workerID || isTerminal(task.Status) {
			continue
		}
		cancelRequested := ts.hasCancelIntentLocked(workerID, taskID)
		delete(ts.taskLeases, taskID)
		delete(ts.cancelLeases, taskID)
		delete(ts.deliveries, taskID)
		ts.removeWorkLocked(workerID, taskID)
		ts.removeCancelLocked(workerID, taskID)

		if cancelRequested {
			task.Status = domain.TaskCanceled
			now := domain.NowISO()
			task.CompletedAt = &now
			ts.notifyResultLocked(taskID, &domain.TaskResult{
				TaskID:      taskID,
				WorkerID:    workerID,
				Status:      domain.TaskCanceled,
				CompletedAt: &now,
			})
		} else {
			task.Status = domain.TaskPending
			task.StartedAt = nil
			task.CompletedAt = nil
			task.Result = nil
			task.Error = nil
			task.Truncated = false
			ts.workQueues[workerID] = append(ts.workQueues[workerID], taskID)
		}
		recovered++
	}
	if recovered > 0 {
		ts.signalWaitersLocked(workerID)
	}
	return recovered
}

// RegisterPoller marks an active long-poll claim connection for online checks.
func (ts *Store) RegisterPoller(workerID string) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	ts.pollers[workerID]++
}

// UnregisterPoller clears one active long-poll claim connection.
func (ts *Store) UnregisterPoller(workerID string) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	if ts.pollers[workerID] <= 1 {
		delete(ts.pollers, workerID)
		return
	}
	ts.pollers[workerID]--
}

// HasPoller reports whether the worker currently has an active claim poll.
func (ts *Store) HasPoller(workerID string) bool {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	return ts.pollers[workerID] > 0
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

func (ts *Store) addWaiter(workerID string) chan struct{} {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	ch := make(chan struct{}, 1)
	ts.waiters[workerID] = append(ts.waiters[workerID], ch)
	// If work already arrived between Claim and register, signal immediately.
	if len(ts.workQueues[workerID]) > 0 || len(ts.cancelQ[workerID]) > 0 {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
	return ch
}

func (ts *Store) removeWaiter(workerID string, ch chan struct{}) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	list := ts.waiters[workerID]
	for i, w := range list {
		if w == ch {
			ts.waiters[workerID] = append(list[:i], list[i+1:]...)
			break
		}
	}
	if len(ts.waiters[workerID]) == 0 {
		delete(ts.waiters, workerID)
	}
}

func (ts *Store) nextLeaseDelay(workerID string) (time.Duration, bool) {
	ts.mu.Lock()
	defer ts.mu.Unlock()

	var earliest time.Time
	for _, leases := range []map[string]deliveryLease{ts.taskLeases, ts.cancelLeases} {
		for _, lease := range leases {
			if lease.workerID != workerID {
				continue
			}
			if earliest.IsZero() || lease.expiresAt.Before(earliest) {
				earliest = lease.expiresAt
			}
		}
	}
	if earliest.IsZero() {
		return 0, false
	}
	delay := time.Until(earliest)
	if delay < 0 {
		delay = 0
	}
	return delay, true
}

func (ts *Store) reapExpiredLocked(now time.Time, workerID string) {
	signaled := false
	for taskID, lease := range ts.taskLeases {
		if lease.workerID != workerID || lease.expiresAt.After(now) {
			continue
		}
		delete(ts.taskLeases, taskID)
		task := ts.tasks[taskID]
		if task != nil && task.Status == domain.TaskPending && !queueContains(ts.workQueues[workerID], taskID) {
			ts.workQueues[workerID] = append(ts.workQueues[workerID], taskID)
			signaled = true
		}
	}
	for taskID, lease := range ts.cancelLeases {
		if lease.workerID != workerID || lease.expiresAt.After(now) {
			continue
		}
		delete(ts.cancelLeases, taskID)
		task := ts.tasks[taskID]
		if task == nil || task.Status != domain.TaskRunning {
			continue
		}
		if ts.cancelSet[workerID] == nil {
			ts.cancelSet[workerID] = make(map[string]struct{})
		}
		if _, queued := ts.cancelSet[workerID][taskID]; !queued {
			ts.cancelSet[workerID][taskID] = struct{}{}
			ts.cancelQ[workerID] = append(ts.cancelQ[workerID], taskID)
			signaled = true
		}
	}
	if signaled {
		ts.signalWaitersLocked(workerID)
	}
}

func (ts *Store) hasCancelIntentLocked(workerID, taskID string) bool {
	if _, leased := ts.cancelLeases[taskID]; leased {
		return true
	}
	if set := ts.cancelSet[workerID]; set != nil {
		_, queued := set[taskID]
		return queued
	}
	return false
}

func queueContains(queue []string, taskID string) bool {
	for _, id := range queue {
		if id == taskID {
			return true
		}
	}
	return false
}

func generateDeliveryID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		panic("generate delivery id: " + err.Error())
	}
	return "job_" + hex.EncodeToString(b)
}

func (ts *Store) signalWaitersLocked(workerID string) {
	for _, ch := range ts.waiters[workerID] {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

func (ts *Store) notifyResultLocked(taskID string, result *domain.TaskResult) {
	if ch, ok := ts.pending[taskID]; ok {
		select {
		case ch <- result:
		default:
		}
	}
}

func (ts *Store) removeWorkLocked(workerID, taskID string) {
	q := ts.workQueues[workerID]
	if len(q) == 0 {
		return
	}
	out := q[:0]
	for _, id := range q {
		if id != taskID {
			out = append(out, id)
		}
	}
	if len(out) == 0 {
		delete(ts.workQueues, workerID)
	} else {
		ts.workQueues[workerID] = out
	}
}

func (ts *Store) removeCancelLocked(workerID, taskID string) {
	delete(ts.cancelLeases, taskID)
	if set := ts.cancelSet[workerID]; set != nil {
		delete(set, taskID)
		if len(set) == 0 {
			delete(ts.cancelSet, workerID)
		}
	}
	q := ts.cancelQ[workerID]
	if len(q) == 0 {
		return
	}
	out := q[:0]
	for _, id := range q {
		if id != taskID {
			out = append(out, id)
		}
	}
	if len(out) == 0 {
		delete(ts.cancelQ, workerID)
	} else {
		ts.cancelQ[workerID] = out
	}
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
