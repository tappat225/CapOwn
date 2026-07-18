package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/capown/master/internal/domain"
	"github.com/capown/master/internal/tasks"
)

// TaskDispatchRequest is the JSON body for POST /v1/tasks.
type taskDispatchRequest struct {
	TargetWorker  string      `json:"target_worker"`
	Payload       taskPayload `json:"payload"`
	TimeoutSecond *int        `json:"timeout_seconds"`
}

type taskPayload struct {
	TaskType string                 `json:"task_type"`
	Params   map[string]interface{} `json:"params"`
}

// TaskResultReport is the Worker's PUT body for /v1/tasks/{task_id}/result.
type taskResultReport struct {
	TaskID      string            `json:"task_id"`
	WorkerID    string            `json:"worker_id"`
	Status      domain.TaskStatus `json:"status"`
	Result      json.RawMessage   `json:"result,omitempty"`
	Error       json.RawMessage   `json:"error,omitempty"`
	StartedAt   *string           `json:"started_at"`
	CompletedAt *string           `json:"completed_at"`
	Truncated   bool              `json:"truncated"`
}

// taskResponse is the JSON response for task endpoints.
type taskResponse struct {
	TaskID        string            `json:"task_id"`
	TargetWorker  string            `json:"target_worker"`
	TaskType      string            `json:"task_type"`
	Params        interface{}       `json:"params"`
	Status        domain.TaskStatus `json:"status"`
	TimeoutSecond int               `json:"timeout_seconds"`
	CreatedAt     string            `json:"created_at"`
	StartedAt     *string           `json:"started_at,omitempty"`
	CompletedAt   *string           `json:"completed_at,omitempty"`
	Result        interface{}       `json:"result,omitempty"`
	Error         *domain.APIError  `json:"error,omitempty"`
	Truncated     bool              `json:"truncated"`
}

func decodeStrictRaw(raw json.RawMessage, dst interface{}) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func hasJSONFields(raw json.RawMessage, required ...string) bool {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return false
	}
	for _, name := range required {
		if _, ok := fields[name]; !ok {
			return false
		}
	}
	return true
}

func toTaskResponse(t *domain.Task) *taskResponse {
	if t == nil {
		return nil
	}
	return &taskResponse{
		TaskID:        t.TaskID,
		TargetWorker:  t.TargetWorker,
		TaskType:      t.TaskType,
		Params:        t.Params,
		Status:        t.Status,
		TimeoutSecond: t.TimeoutSecond,
		CreatedAt:     t.CreatedAt,
		StartedAt:     t.StartedAt,
		CompletedAt:   t.CompletedAt,
		Result:        t.Result,
		Error:         t.Error,
		Truncated:     t.Truncated,
	}
}

func (s *Server) handleListWorkerPlugins(w http.ResponseWriter, r *http.Request) {
	workerID := r.PathValue("worker_id")
	if workerID == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "worker_id is required")
		return
	}

	ctx, apiErr := s.resolveAPI(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	worker, err := s.store.GetActiveWorker(workerID)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	if worker == nil {
		writeErrorCode(w, http.StatusNotFound, domain.ErrWorkerNotFound, "worker not found")
		return
	}

	if ctx.UserID != worker.OwnerUserID && !ctx.hasAdminScope() {
		writeErrorCode(w, http.StatusForbidden, domain.ErrForbidden, "not your worker")
		return
	}

	plugins, err := s.store.GetWorkerPlugins(workerID)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}

	writeJSON(w, http.StatusOK, plugins)
}

func (s *Server) handleDispatchTask(w http.ResponseWriter, r *http.Request) {
	ctx, apiErr := s.resolveClientAPI(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	var req taskDispatchRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}

	if req.TargetWorker == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "target_worker is required")
		return
	}
	if req.Payload.TaskType == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "payload.task_type is required")
		return
	}
	if req.Payload.Params == nil {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "payload.params is required")
		return
	}
	if req.Payload.TaskType != "plugin_call" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "unsupported task_type; only plugin_call is supported")
		return
	}

	timeout := 120
	if req.TimeoutSecond != nil {
		if *req.TimeoutSecond < 1 || *req.TimeoutSecond > 3600 {
			writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "timeout_seconds must be between 1 and 3600")
			return
		}
		timeout = *req.TimeoutSecond
	}

	doWait := false
	if waitValues, ok := r.URL.Query()["wait"]; ok {
		if len(waitValues) != 1 {
			writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "wait must be a single boolean value")
			return
		}
		parsed, err := strconv.ParseBool(waitValues[0])
		if err != nil {
			writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "wait must be a boolean")
			return
		}
		doWait = parsed
	}

	worker, err := s.store.GetActiveWorker(req.TargetWorker)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	if worker == nil {
		writeErrorCode(w, http.StatusNotFound, domain.ErrWorkerNotFound, "worker not found")
		return
	}

	if ctx.UserID != worker.OwnerUserID && !ctx.hasAdminScope() {
		writeErrorCode(w, http.StatusForbidden, domain.ErrForbidden, "not your worker")
		return
	}

	if !s.workerBroker.IsConnected(req.TargetWorker) {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrWorkerOffline, "worker is not connected")
		return
	}

	task := &domain.Task{
		TaskID:        domain.GenerateTaskID(),
		TargetWorker:  req.TargetWorker,
		TaskType:      req.Payload.TaskType,
		Params:        req.Payload.Params,
		Status:        domain.TaskPending,
		TimeoutSecond: timeout,
		CreatedAt:     domain.NowISO(),
		OwnerUserID:   ctx.UserID,
	}

	s.taskStore.Create(task)

	var pending <-chan *domain.TaskResult
	if doWait {
		task = s.taskStore.UpdateStatus(task.TaskID, domain.TaskRunning)
		// Register pending channel BEFORE the SSE push to avoid losing fast results
		pending = s.taskStore.RegisterPending(task.TaskID)
		defer s.taskStore.UnregisterPending(task.TaskID)
	}

	eventData := tasks.SSEEventDataForTask(task)
	if !s.workerBroker.Push(req.TargetWorker, "task", eventData) {
		s.taskStore.Delete(task.TaskID)
		writeErrorCode(w, http.StatusServiceUnavailable, domain.ErrWorkerOffline, "worker queue full or disconnected")
		return
	}

	if doWait {
		timeoutDuration := time.Duration(timeout) * time.Second
		if timeoutDuration > 60*time.Second {
			timeoutDuration = 60 * time.Second
		}
		result := s.taskStore.WaitForResult(pending, timeoutDuration)
		if result != nil {
			task = s.taskStore.Get(task.TaskID)
			writeJSON(w, http.StatusOK, toTaskResponse(task))
			return
		}
		task = s.taskStore.Get(task.TaskID)
		writeJSON(w, http.StatusRequestTimeout, toTaskResponse(task))
		return
	}

	task = s.taskStore.Get(task.TaskID)
	w.Header().Set("Location", "/v1/tasks/"+task.TaskID)
	writeJSON(w, http.StatusAccepted, toTaskResponse(task))
}

func (s *Server) handleGetTask(w http.ResponseWriter, r *http.Request) {
	taskID := r.PathValue("task_id")
	if taskID == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "task_id is required")
		return
	}

	ctx, apiErr := s.resolveClientAPI(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	task := s.taskStore.Get(taskID)
	if task == nil {
		writeErrorCode(w, http.StatusNotFound, domain.ErrNotFound, "task not found")
		return
	}

	if ctx.UserID != task.OwnerUserID && !ctx.hasAdminScope() {
		writeErrorCode(w, http.StatusForbidden, domain.ErrForbidden, "not your task")
		return
	}

	writeJSON(w, http.StatusOK, toTaskResponse(task))
}

func (s *Server) handleReportTaskResult(w http.ResponseWriter, r *http.Request) {
	taskID := r.PathValue("task_id")
	if taskID == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "task_id is required")
		return
	}

	var report taskResultReport
	if err := decodeJSON(r, &report); err != nil {
		writeError(w, err)
		return
	}

	if report.TaskID != taskID {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "task_id mismatch")
		return
	}
	if report.WorkerID == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "worker_id is required")
		return
	}

	_, apiErr := s.resolveWorkerSession(r, report.WorkerID)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	result := &domain.TaskResult{
		TaskID:      report.TaskID,
		WorkerID:    report.WorkerID,
		Status:      report.Status,
		StartedAt:   report.StartedAt,
		CompletedAt: report.CompletedAt,
		Truncated:   report.Truncated,
	}
	for _, timestamp := range []*string{report.StartedAt, report.CompletedAt} {
		if timestamp == nil {
			continue
		}
		parsed, err := time.Parse(time.RFC3339, *timestamp)
		_, offset := parsed.Zone()
		if err != nil || offset != 0 {
			writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "task timestamps must be UTC RFC 3339 values")
			return
		}
	}

	if report.Result != nil {
		if !hasJSONFields(report.Result, "is_error", "content") {
			writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "result requires is_error and content")
			return
		}
		var pluginResult domain.PluginCallResult
		if err := decodeStrictRaw(report.Result, &pluginResult); err != nil || pluginResult.Content == nil {
			writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "malformed result body")
			return
		}
		for _, block := range pluginResult.Content {
			if block.Type != "text" && block.Type != "json" {
				writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "invalid result content block")
				return
			}
		}
		switch pluginResult.StructuredContent.(type) {
		case nil, map[string]interface{}, []interface{}:
		default:
			writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "structured_content must be an object, array, or null")
			return
		}
		result.Result = &pluginResult
	}
	if report.Error != nil {
		if !hasJSONFields(report.Error, "code", "message", "details") {
			writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "error requires code, message, and details")
			return
		}
		var apiErr domain.APIError
		if err := decodeStrictRaw(report.Error, &apiErr); err != nil || apiErr.Code == "" || apiErr.Message == "" {
			writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "malformed error body")
			return
		}
		result.Error = &apiErr
	}
	if report.Status == domain.TaskCompleted && (result.Result == nil || result.Error != nil) {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "completed task requires result and no error")
		return
	}
	if report.Status == domain.TaskRunning && (result.Result != nil || result.Error != nil) {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "running task cannot include result or error")
		return
	}

	_, applyErr := s.taskStore.ApplyResult(taskID, report.WorkerID, result)
	switch applyErr {
	case "":
	case "not_found":
		writeErrorCode(w, http.StatusNotFound, domain.ErrNotFound, "task not found")
		return
	case "wrong_worker":
		writeErrorCode(w, http.StatusForbidden, domain.ErrForbidden, "worker does not own this task")
		return
	case "terminal":
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "task is already in a terminal state")
		return
	case "invalid_status", "invalid_transition":
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "invalid task status transition")
		return
	default:
		writeError(w, domain.ErrInternalResponse)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleCancelTask(w http.ResponseWriter, r *http.Request) {
	taskID := r.PathValue("task_id")
	if taskID == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "task_id is required")
		return
	}

	ctx, apiErr := s.resolveClientAPI(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	task := s.taskStore.Get(taskID)
	if task == nil {
		writeErrorCode(w, http.StatusNotFound, domain.ErrNotFound, "task not found")
		return
	}

	if ctx.UserID != task.OwnerUserID && !ctx.hasAdminScope() {
		writeErrorCode(w, http.StatusForbidden, domain.ErrForbidden, "not your task")
		return
	}

	if task.Status == domain.TaskCompleted || task.Status == domain.TaskFailed ||
		task.Status == domain.TaskTimeout || task.Status == domain.TaskCanceled {
		writeJSON(w, http.StatusOK, toTaskResponse(task))
		return
	}

	// Verify worker is still connected for cancellation dispatch
	if !s.workerBroker.IsConnected(task.TargetWorker) {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrWorkerOffline, "worker is not connected")
		return
	}

	cancelPayload := map[string]interface{}{
		"task_id": taskID,
	}
	dispatchData := &tasks.SSEEventData{
		TaskID:        domain.GenerateTaskID(),
		TaskType:      "task_cancel",
		Params:        cancelPayload,
		TimeoutSecond: 15,
	}

	if !s.workerBroker.Push(task.TargetWorker, "task", dispatchData) {
		writeErrorCode(w, http.StatusServiceUnavailable, domain.ErrWorkerOffline, "worker not connected")
		return
	}

	task = s.taskStore.MarkCanceled(taskID)

	writeJSON(w, http.StatusOK, toTaskResponse(task))
}
