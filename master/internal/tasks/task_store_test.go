// SPDX-License-Identifier: Apache-2.0

package tasks

import (
	"context"
	"testing"
	"time"

	"github.com/capown/master/internal/domain"
)

func newTestTask(status domain.TaskStatus) *domain.Task {
	return &domain.Task{
		TaskID:        "tsk_0123456789abcdef01234567",
		TargetWorker:  "wrk_0123456789abcdef01234567",
		TaskType:      "plugin_call",
		Params:        map[string]interface{}{"plugin_id": "demo"},
		Status:        status,
		TimeoutSecond: 60,
		CreatedAt:     domain.NowISO(),
		OwnerUserID:   "usr_test",
	}
}

func currentTaskDeliveryID(t *testing.T, store *Store, taskID string) string {
	t.Helper()
	store.mu.Lock()
	defer store.mu.Unlock()
	deliveryID := store.taskLeases[taskID].deliveryID
	if deliveryID == "" {
		t.Fatal("task has no active delivery lease")
	}
	return deliveryID
}

func confirmRunning(t *testing.T, store *Store, task *domain.Task) string {
	t.Helper()
	deliveryID := currentTaskDeliveryID(t, store, task.TaskID)
	result := &domain.TaskResult{
		TaskID:     task.TaskID,
		DeliveryID: deliveryID,
		WorkerID:   task.TargetWorker,
		Status:     domain.TaskRunning,
	}
	if _, code := store.ApplyResult(task.TaskID, task.TargetWorker, result); code != "" {
		t.Fatalf("confirm running code = %q", code)
	}
	return deliveryID
}

func TestWaitForResultUsesPreRegisteredChannel(t *testing.T) {
	store := NewStore()
	task := newTestTask(domain.TaskPending)
	store.EnqueuePending(task)
	if jobs := store.Claim(task.TargetWorker, 1); len(jobs) != 1 {
		t.Fatalf("setup claim failed: %#v", jobs)
	}
	deliveryID := confirmRunning(t, store, task)
	pending := store.RegisterPending(task.TaskID)
	defer store.UnregisterPending(task.TaskID)

	result := &domain.TaskResult{
		TaskID:     task.TaskID,
		DeliveryID: deliveryID,
		WorkerID:   task.TargetWorker,
		Status:     domain.TaskCompleted,
	}
	if _, code := store.ApplyResult(task.TaskID, task.TargetWorker, result); code != "" {
		t.Fatalf("ApplyResult() code = %q, want empty", code)
	}

	if got := store.WaitForResult(pending, 100*time.Millisecond); got != result {
		t.Fatalf("WaitForResult() = %#v, want original result", got)
	}
}

func TestApplyResultRejectsWrongWorkerAndTerminalOverwrite(t *testing.T) {
	store := NewStore()
	task := newTestTask(domain.TaskPending)
	store.EnqueuePending(task)
	if jobs := store.Claim(task.TargetWorker, 1); len(jobs) != 1 {
		t.Fatalf("setup claim failed: %#v", jobs)
	}

	deliveryID := currentTaskDeliveryID(t, store, task.TaskID)
	result := &domain.TaskResult{TaskID: task.TaskID, DeliveryID: deliveryID, Status: domain.TaskCompleted}
	if _, code := store.ApplyResult(task.TaskID, "wrk_aaaaaaaaaaaaaaaaaaaaaaaa", result); code != "wrong_worker" {
		t.Fatalf("wrong worker code = %q", code)
	}

	confirmRunning(t, store, task)
	result.WorkerID = task.TargetWorker
	if _, code := store.ApplyResult(task.TaskID, task.TargetWorker, result); code != "" {
		t.Fatalf("first terminal result code = %q", code)
	}
	result.Status = domain.TaskFailed
	if _, code := store.ApplyResult(task.TaskID, task.TargetWorker, result); code != "terminal" {
		t.Fatalf("terminal overwrite code = %q", code)
	}
}

func TestGetReturnsCopy(t *testing.T) {
	store := NewStore()
	task := newTestTask(domain.TaskPending)
	store.EnqueuePending(task)

	copy := store.Get(task.TaskID)
	copy.Status = domain.TaskFailed
	if got := store.Get(task.TaskID).Status; got != domain.TaskPending {
		t.Fatalf("stored status mutated through Get(): %q", got)
	}
}

func TestClaimReservesPendingUntilRunningConfirmation(t *testing.T) {
	store := NewStore()
	task := newTestTask(domain.TaskPending)
	store.EnqueuePending(task)

	jobs := store.Claim(task.TargetWorker, 1)
	if len(jobs) != 1 {
		t.Fatalf("Claim() len = %d, want 1", len(jobs))
	}
	if jobs[0].JobType != JobTypeTask || jobs[0].TaskID != task.TaskID {
		t.Fatalf("Claim() job = %#v", jobs[0])
	}
	got := store.Get(task.TaskID)
	if got.Status != domain.TaskPending {
		t.Fatalf("status after claim = %q, want pending", got.Status)
	}
	if got.StartedAt != nil {
		t.Fatal("started_at must not be set before running confirmation")
	}
	if second := store.Claim(task.TargetWorker, 1); len(second) != 0 {
		t.Fatalf("second claim should be empty, got %#v", second)
	}
	confirmRunning(t, store, task)
	got = store.Get(task.TaskID)
	if got.Status != domain.TaskRunning || got.StartedAt == nil {
		t.Fatalf("task after confirmation = %#v", got)
	}
}

func TestApplyRunningResultAfterClaimIsAccepted(t *testing.T) {
	store := NewStore()
	task := newTestTask(domain.TaskPending)
	store.EnqueuePending(task)
	if jobs := store.Claim(task.TargetWorker, 1); len(jobs) != 1 {
		t.Fatalf("setup claim failed: %#v", jobs)
	}

	result := &domain.TaskResult{
		TaskID:     task.TaskID,
		DeliveryID: currentTaskDeliveryID(t, store, task.TaskID),
		WorkerID:   task.TargetWorker,
		Status:     domain.TaskRunning,
	}
	if _, code := store.ApplyResult(task.TaskID, task.TargetWorker, result); code != "" {
		t.Fatalf("running result after claim code = %q, want empty", code)
	}
	if got := store.Get(task.TaskID).Status; got != domain.TaskRunning {
		t.Fatalf("status after running result = %q, want running", got)
	}
}

func TestRunningConfirmationRequiresActiveDeliveryLease(t *testing.T) {
	store := NewStore()
	task := newTestTask(domain.TaskPending)
	store.EnqueuePending(task)
	result := &domain.TaskResult{
		TaskID:     task.TaskID,
		DeliveryID: "job_aaaaaaaaaaaaaaaaaaaaaaaa",
		WorkerID:   task.TargetWorker,
		Status:     domain.TaskRunning,
	}
	if _, code := store.ApplyResult(task.TaskID, task.TargetWorker, result); code != "invalid_transition" {
		t.Fatalf("unclaimed running confirmation code = %q", code)
	}
}

func TestCancelPendingRemovesFromQueue(t *testing.T) {
	store := NewStore()
	task := newTestTask(domain.TaskPending)
	store.EnqueuePending(task)

	canceled, ok := store.CancelPending(task.TaskID)
	if !ok || canceled.Status != domain.TaskCanceled {
		t.Fatalf("CancelPending() = %#v ok=%v", canceled, ok)
	}
	if jobs := store.Claim(task.TargetWorker, 1); len(jobs) != 0 {
		t.Fatalf("canceled task still claimable: %#v", jobs)
	}
}

func TestEnqueueCancelClaimedAsCancelJob(t *testing.T) {
	store := NewStore()
	task := newTestTask(domain.TaskPending)
	store.EnqueuePending(task)
	if jobs := store.Claim(task.TargetWorker, 1); len(jobs) != 1 {
		t.Fatalf("setup claim failed: %#v", jobs)
	}
	confirmRunning(t, store, task)

	if _, ok := store.EnqueueCancel(task.TaskID); !ok {
		t.Fatal("EnqueueCancel failed for running task")
	}
	// Duplicate enqueue is ignored.
	if _, ok := store.EnqueueCancel(task.TaskID); !ok {
		t.Fatal("duplicate EnqueueCancel should still report running task")
	}

	jobs := store.Claim(task.TargetWorker, 2)
	if len(jobs) != 1 || jobs[0].JobType != JobTypeCancel || jobs[0].TaskID != task.TaskID {
		t.Fatalf("cancel claim = %#v", jobs)
	}
}

func TestUnconfirmedTaskLeaseExpiresAndRedelivers(t *testing.T) {
	store := newStoreWithLeaseDuration(20 * time.Millisecond)
	task := newTestTask(domain.TaskPending)
	store.EnqueuePending(task)

	if jobs := store.Claim(task.TargetWorker, 1); len(jobs) != 1 {
		t.Fatalf("first claim = %#v", jobs)
	}
	time.Sleep(30 * time.Millisecond)
	jobs := store.Claim(task.TargetWorker, 1)
	if len(jobs) != 1 || jobs[0].TaskID != task.TaskID {
		t.Fatalf("redelivery after lease expiry = %#v", jobs)
	}
}

func TestExpiredDeliveryCannotConfirmNewLease(t *testing.T) {
	store := newStoreWithLeaseDuration(20 * time.Millisecond)
	task := newTestTask(domain.TaskPending)
	store.EnqueuePending(task)
	first := store.Claim(task.TargetWorker, 1)
	if len(first) != 1 {
		t.Fatalf("first claim = %#v", first)
	}
	time.Sleep(30 * time.Millisecond)
	second := store.Claim(task.TargetWorker, 1)
	if len(second) != 1 || second[0].DeliveryID == first[0].DeliveryID {
		t.Fatalf("second claim = %#v", second)
	}
	stale := &domain.TaskResult{
		TaskID:     task.TaskID,
		DeliveryID: first[0].DeliveryID,
		WorkerID:   task.TargetWorker,
		Status:     domain.TaskRunning,
	}
	if _, code := store.ApplyResult(task.TaskID, task.TargetWorker, stale); code != "invalid_transition" {
		t.Fatalf("stale delivery code = %q", code)
	}
	current := *stale
	current.DeliveryID = second[0].DeliveryID
	if _, code := store.ApplyResult(task.TaskID, task.TargetWorker, &current); code != "" {
		t.Fatalf("current delivery code = %q", code)
	}
}

func TestCancelLeaseExpiresAndRedelivers(t *testing.T) {
	store := newStoreWithLeaseDuration(20 * time.Millisecond)
	task := newTestTask(domain.TaskPending)
	store.EnqueuePending(task)
	if jobs := store.Claim(task.TargetWorker, 1); len(jobs) != 1 {
		t.Fatalf("setup claim failed: %#v", jobs)
	}
	confirmRunning(t, store, task)
	if _, ok := store.EnqueueCancel(task.TaskID); !ok {
		t.Fatal("EnqueueCancel failed")
	}
	if jobs := store.Claim(task.TargetWorker, 1); len(jobs) != 1 || jobs[0].JobType != JobTypeCancel {
		t.Fatalf("first cancel claim = %#v", jobs)
	}
	time.Sleep(30 * time.Millisecond)
	if jobs := store.Claim(task.TargetWorker, 1); len(jobs) != 1 || jobs[0].JobType != JobTypeCancel {
		t.Fatalf("cancel redelivery = %#v", jobs)
	}
}

func TestTerminalResultIsIdempotent(t *testing.T) {
	store := NewStore()
	task := newTestTask(domain.TaskPending)
	store.EnqueuePending(task)
	if jobs := store.Claim(task.TargetWorker, 1); len(jobs) != 1 {
		t.Fatalf("setup claim failed: %#v", jobs)
	}
	deliveryID := confirmRunning(t, store, task)
	result := &domain.TaskResult{
		TaskID:     task.TaskID,
		DeliveryID: deliveryID,
		WorkerID:   task.TargetWorker,
		Status:     domain.TaskFailed,
	}
	if _, code := store.ApplyResult(task.TaskID, task.TargetWorker, result); code != "" {
		t.Fatalf("first terminal result code = %q", code)
	}
	if _, code := store.ApplyResult(task.TaskID, task.TargetWorker, result); code != "" {
		t.Fatalf("duplicate terminal result code = %q", code)
	}
}

func TestRecoverWorkerRequeuesRunningTask(t *testing.T) {
	store := NewStore()
	task := newTestTask(domain.TaskPending)
	store.EnqueuePending(task)
	if jobs := store.Claim(task.TargetWorker, 1); len(jobs) != 1 {
		t.Fatalf("setup claim failed: %#v", jobs)
	}
	confirmRunning(t, store, task)

	if recovered := store.RecoverWorker(task.TargetWorker); recovered != 1 {
		t.Fatalf("RecoverWorker() = %d, want 1", recovered)
	}
	if got := store.Get(task.TaskID); got.Status != domain.TaskPending || got.StartedAt != nil {
		t.Fatalf("recovered task = %#v", got)
	}
	if jobs := store.Claim(task.TargetWorker, 1); len(jobs) != 1 || jobs[0].TaskID != task.TaskID {
		t.Fatalf("recovered task not claimable: %#v", jobs)
	}
}

func TestClaimOrWaitReceivesEnqueuedJob(t *testing.T) {
	store := NewStore()
	workerID := "wrk_0123456789abcdef01234567"
	done := make(chan []WorkerJob, 1)

	go func() {
		done <- store.ClaimOrWait(context.Background(), workerID, 1, 2*time.Second)
	}()

	time.Sleep(50 * time.Millisecond)
	task := newTestTask(domain.TaskPending)
	store.EnqueuePending(task)

	select {
	case jobs := <-done:
		if len(jobs) != 1 || jobs[0].TaskID != task.TaskID {
			t.Fatalf("ClaimOrWait jobs = %#v", jobs)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("ClaimOrWait timed out")
	}
}

func TestBlockWorkerInterruptsClaimAndCanBeReenabled(t *testing.T) {
	store := NewStore()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	done := make(chan []WorkerJob, 1)
	go func() {
		done <- store.ClaimOrWait(ctx, "wrk_blocked", 1, time.Second)
	}()
	time.Sleep(10 * time.Millisecond)
	store.BlockWorker("wrk_blocked")
	select {
	case jobs := <-done:
		if len(jobs) != 0 {
			t.Fatalf("blocked worker claimed jobs: %#v", jobs)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("blocking a worker did not interrupt its claim")
	}
	store.UnblockWorker("wrk_blocked")
	if store.IsWorkerBlocked("wrk_blocked") {
		t.Fatal("worker should be unblocked")
	}
}
