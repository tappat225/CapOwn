// SPDX-License-Identifier: Apache-2.0

package tasks

import (
	"testing"
	"time"

	"github.com/capown/master/internal/domain"
)

func newTestTask() *domain.Task {
	return &domain.Task{
		TaskID:       "tsk_0123456789abcdef01234567",
		TargetWorker: "wrk_0123456789abcdef01234567",
		TaskType:     "plugin_call",
		Status:       domain.TaskRunning,
		CreatedAt:    domain.NowISO(),
		OwnerUserID:  "usr_test",
	}
}

func TestWaitForResultUsesPreRegisteredChannel(t *testing.T) {
	store := NewStore()
	task := newTestTask()
	store.Create(task)
	pending := store.RegisterPending(task.TaskID)
	defer store.UnregisterPending(task.TaskID)

	result := &domain.TaskResult{
		TaskID:   task.TaskID,
		WorkerID: task.TargetWorker,
		Status:   domain.TaskCompleted,
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
	task := newTestTask()
	store.Create(task)

	result := &domain.TaskResult{TaskID: task.TaskID, Status: domain.TaskCompleted}
	if _, code := store.ApplyResult(task.TaskID, "wrk_aaaaaaaaaaaaaaaaaaaaaaaa", result); code != "wrong_worker" {
		t.Fatalf("wrong worker code = %q", code)
	}

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
	task := newTestTask()
	store.Create(task)

	copy := store.Get(task.TaskID)
	copy.Status = domain.TaskFailed
	if got := store.Get(task.TaskID).Status; got != domain.TaskRunning {
		t.Fatalf("stored status mutated through Get(): %q", got)
	}
}
