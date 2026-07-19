// SPDX-License-Identifier: Apache-2.0

package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/capown/master/internal/domain"
	"github.com/capown/master/internal/store"
)

const (
	mcpProtocolVersion = "2025-03-26"
	mcpServerName      = "capown"
	mcpServerVersion   = "0.1.0"
)

type mcpJSONRPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type mcpJSONRPCResponse struct {
	JSONRPC string           `json:"jsonrpc"`
	ID      json.RawMessage  `json:"id"`
	Result  interface{}      `json:"result,omitempty"`
	Error   *mcpJSONRPCError `json:"error,omitempty"`
}

type mcpJSONRPCError struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

type mcpTool struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	InputSchema map[string]interface{} `json:"inputSchema"`
}

type mcpToolCallParams struct {
	Name      string                     `json:"name"`
	Arguments map[string]json.RawMessage `json:"arguments"`
	Meta      json.RawMessage            `json:"_meta"`
}

type mcpToolCallResult struct {
	Content           []mcpContent `json:"content"`
	IsError           bool         `json:"isError,omitempty"`
	StructuredContent interface{}  `json:"structuredContent,omitempty"`
}

type mcpContent struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

type mcpToolFailure struct {
	Code    string
	Message string
	Details interface{}
}

type mcpWorkerInput struct {
	Worker string `json:"worker"`
}

type mcpPluginCallInput struct {
	Worker         string                 `json:"worker"`
	PluginID       string                 `json:"plugin_id"`
	ToolName       string                 `json:"tool_name"`
	Arguments      map[string]interface{} `json:"arguments"`
	TimeoutSeconds int                    `json:"timeout_seconds"`
}

type mcpTaskInput struct {
	TaskID string `json:"task_id"`
}

type mcpTaskWaitInput struct {
	TaskID         string `json:"task_id"`
	TimeoutSeconds int    `json:"timeout_seconds"`
}

func (s *Server) handleMCPMethodNotAllowed(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Allow", http.MethodPost)
	writeMCPError(w, http.StatusMethodNotAllowed, nil, -32600, "MCP endpoint only accepts POST requests", nil)
}

func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	ctx, apiErr := s.resolveMCPClient(r)
	if apiErr != nil {
		writeMCPError(w, apiErr.Status, nil, -32001, apiErr.Message, map[string]string{"code": apiErr.Code})
		return
	}

	if !mcpAcceptsStreamableHTTP(r.Header.Get("Accept")) {
		writeMCPError(w, http.StatusNotAcceptable, nil, -32600,
			"Accept must include application/json and text/event-stream", nil)
		return
	}
	if !mcpIsJSONContentType(r.Header.Get("Content-Type")) {
		writeMCPError(w, http.StatusUnsupportedMediaType, nil, -32600,
			"Content-Type must be application/json", nil)
		return
	}

	var request mcpJSONRPCRequest
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&request); err != nil {
		writeMCPError(w, http.StatusBadRequest, nil, -32700, "invalid JSON", nil)
		return
	}
	var extra interface{}
	if err := decoder.Decode(&extra); err != io.EOF {
		writeMCPError(w, http.StatusBadRequest, request.ID, -32600, "request must contain one JSON-RPC message", nil)
		return
	}

	if request.JSONRPC != "2.0" || request.Method == "" {
		writeMCPError(w, http.StatusBadRequest, request.ID, -32600, "invalid JSON-RPC request", nil)
		return
	}

	if request.ID == nil {
		if request.Method == "notifications/initialized" || request.Method == "notifications/cancelled" {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		writeMCPError(w, http.StatusBadRequest, nil, -32600, "requests must include an id", nil)
		return
	}

	switch request.Method {
	case "initialize":
		writeMCPResponse(w, http.StatusOK, mcpSuccess(request.ID, map[string]interface{}{
			"protocolVersion": mcpProtocolVersion,
			"capabilities": map[string]interface{}{
				"tools": map[string]interface{}{"listChanged": false},
			},
			"serverInfo": map[string]string{
				"name":    mcpServerName,
				"version": mcpServerVersion,
			},
			"instructions": "CapOwn next MCP server. Use plugin_call to invoke tools on owned Workers.",
		}))
	case "ping":
		writeMCPResponse(w, http.StatusOK, mcpSuccess(request.ID, map[string]interface{}{}))
	case "tools/list":
		writeMCPResponse(w, http.StatusOK, mcpSuccess(request.ID, map[string]interface{}{
			"tools": mcpTools(),
		}))
	case "tools/call":
		var params mcpToolCallParams
		if err := decodeMCPParams(request.Params, &params); err != nil || params.Name == "" {
			writeMCPError(w, http.StatusBadRequest, request.ID, -32602, "invalid tools/call parameters", nil)
			return
		}
		result, toolErr := s.callMCPTool(r.Context(), ctx, params.Name, params.Arguments)
		if toolErr != nil {
			writeMCPError(w, http.StatusOK, request.ID, -32602, toolErr.Message, nil)
			return
		}
		writeMCPResponse(w, http.StatusOK, mcpSuccess(request.ID, result))
	default:
		writeMCPError(w, http.StatusOK, request.ID, -32601, "method not found: "+request.Method, nil)
	}
}

func (s *Server) resolveMCPClient(r *http.Request) (*AuthContext, *domain.APIError) {
	ctx, apiErr := s.resolveClientAPI(r)
	if apiErr != nil {
		return nil, apiErr
	}
	if ctx.TokenType != "client" {
		return nil, domain.NewAPIError(domain.ErrForbidden,
			"MCP requires a client token", http.StatusForbidden)
	}
	if origin := r.Header.Get("Origin"); origin != "" && !mcpOriginMatches(origin, s.config.Master.PublicURL) {
		return nil, domain.NewAPIError(domain.ErrForbidden, "request Origin is not allowed", http.StatusForbidden)
	}
	return ctx, nil
}

func mcpAcceptsStreamableHTTP(value string) bool {
	hasJSON := false
	hasSSE := false
	for _, item := range strings.Split(value, ",") {
		mediaType := strings.TrimSpace(strings.SplitN(item, ";", 2)[0])
		switch strings.ToLower(mediaType) {
		case "application/json":
			hasJSON = true
		case "text/event-stream":
			hasSSE = true
		}
	}
	return hasJSON && hasSSE
}

func mcpIsJSONContentType(value string) bool {
	mediaType, _, err := mime.ParseMediaType(value)
	return err == nil && strings.EqualFold(mediaType, "application/json")
}

func mcpOriginMatches(origin, publicURL string) bool {
	if publicURL == "" {
		return false
	}
	originURL, err := url.Parse(origin)
	if err != nil || originURL.Scheme == "" || originURL.Host == "" || originURL.Path != "" || originURL.RawQuery != "" || originURL.Fragment != "" {
		return false
	}
	public, err := url.Parse(publicURL)
	if err != nil || public.Scheme == "" || public.Host == "" {
		return false
	}
	return strings.EqualFold(originURL.Scheme, public.Scheme) && strings.EqualFold(originURL.Host, public.Host)
}

func decodeMCPParams(raw json.RawMessage, dst interface{}) error {
	if len(raw) == 0 || string(raw) == "null" {
		raw = json.RawMessage(`{}`)
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return err
	}
	var extra interface{}
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return io.ErrUnexpectedEOF
		}
		return err
	}
	return nil
}

func decodeMCPToolInput(args map[string]json.RawMessage, dst interface{}) error {
	if args == nil {
		args = map[string]json.RawMessage{}
	}
	raw, err := json.Marshal(args)
	if err != nil {
		return err
	}
	return decodeMCPParams(raw, dst)
}

func mcpSuccess(id json.RawMessage, result interface{}) mcpJSONRPCResponse {
	return mcpJSONRPCResponse{JSONRPC: "2.0", ID: id, Result: result}
}

func writeMCPResponse(w http.ResponseWriter, status int, response mcpJSONRPCResponse) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(response)
}

func writeMCPError(w http.ResponseWriter, status int, id json.RawMessage, code int, message string, data interface{}) {
	if id == nil {
		id = json.RawMessage("null")
	}
	writeMCPResponse(w, status, mcpJSONRPCResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error: &mcpJSONRPCError{
			Code:    code,
			Message: message,
			Data:    data,
		},
	})
}

func mcpTools() []mcpTool {
	return []mcpTool{
		{
			Name:        "workers_list",
			Description: "List active Workers owned by the authenticated client.",
			InputSchema: mcpObjectSchema(nil, nil),
		},
		{
			Name:        "worker_get",
			Description: "Get one owned Worker by worker ID or worker name.",
			InputSchema: mcpObjectSchema(map[string]interface{}{
				"worker": map[string]interface{}{"type": "string", "description": "Worker ID or exact Worker name."},
			}, []string{"worker"}),
		},
		{
			Name:        "plugin_list",
			Description: "List the plugin snapshot reported by an owned Worker.",
			InputSchema: mcpObjectSchema(map[string]interface{}{
				"worker": map[string]interface{}{"type": "string", "description": "Worker ID or exact Worker name."},
			}, []string{"worker"}),
		},
		{
			Name:        "plugin_call",
			Description: "Invoke a tool exposed by a plugin on an owned Worker.",
			InputSchema: mcpObjectSchema(map[string]interface{}{
				"worker":          map[string]interface{}{"type": "string", "description": "Worker ID or exact Worker name."},
				"plugin_id":       map[string]interface{}{"type": "string"},
				"tool_name":       map[string]interface{}{"type": "string"},
				"arguments":       map[string]interface{}{"type": "object", "additionalProperties": true},
				"timeout_seconds": map[string]interface{}{"type": "integer", "minimum": 1, "maximum": 3600, "default": 120},
			}, []string{"worker", "plugin_id", "tool_name"}),
		},
		{
			Name:        "task_get",
			Description: "Get the status and result of an owned task.",
			InputSchema: mcpObjectSchema(map[string]interface{}{
				"task_id": map[string]interface{}{"type": "string"},
			}, []string{"task_id"}),
		},
		{
			Name:        "task_wait",
			Description: "Wait for an owned task for up to 60 seconds and return its current state.",
			InputSchema: mcpObjectSchema(map[string]interface{}{
				"task_id":         map[string]interface{}{"type": "string"},
				"timeout_seconds": map[string]interface{}{"type": "integer", "minimum": 1, "maximum": 60, "default": 30},
			}, []string{"task_id"}),
		},
		{
			Name:        "task_cancel",
			Description: "Cancel an owned pending or running task.",
			InputSchema: mcpObjectSchema(map[string]interface{}{
				"task_id": map[string]interface{}{"type": "string"},
			}, []string{"task_id"}),
		},
	}
}

func mcpObjectSchema(properties map[string]interface{}, required []string) map[string]interface{} {
	if properties == nil {
		properties = map[string]interface{}{}
	}
	if required == nil {
		required = []string{}
	}
	return map[string]interface{}{
		"type":                 "object",
		"properties":           properties,
		"required":             required,
		"additionalProperties": false,
	}
}

func (s *Server) callMCPTool(ctx context.Context, authCtx *AuthContext, name string, args map[string]json.RawMessage) (mcpToolCallResult, *mcpToolFailure) {
	switch name {
	case "workers_list":
		if err := decodeMCPToolInput(args, &struct{}{}); err != nil {
			return mcpToolCallResult{}, &mcpToolFailure{Message: "invalid workers_list arguments"}
		}
		workers, err := s.mcpListWorkers(authCtx)
		if err != nil {
			return mcpFailureResult("internal_error", "failed to list Workers", nil), nil
		}
		return mcpJSONResult(workers), nil

	case "worker_get":
		var input mcpWorkerInput
		if err := decodeMCPToolInput(args, &input); err != nil || input.Worker == "" {
			return mcpToolCallResult{}, &mcpToolFailure{Message: "worker is required"}
		}
		worker, failure := s.mcpResolveWorker(authCtx, input.Worker)
		if failure != nil {
			return mcpFailureResult(failure.Code, failure.Message, failure.Details), nil
		}
		owner, err := s.store.GetUserByID(worker.OwnerUserID)
		if err != nil || owner == nil {
			return mcpFailureResult("internal_error", "failed to load Worker owner", nil), nil
		}
		return mcpJSONResult(workerListItemFromRow(worker, owner.Username)), nil

	case "plugin_list":
		var input mcpWorkerInput
		if err := decodeMCPToolInput(args, &input); err != nil || input.Worker == "" {
			return mcpToolCallResult{}, &mcpToolFailure{Message: "worker is required"}
		}
		worker, failure := s.mcpResolveWorker(authCtx, input.Worker)
		if failure != nil {
			return mcpFailureResult(failure.Code, failure.Message, failure.Details), nil
		}
		plugins, err := s.store.GetWorkerPlugins(worker.WorkerID)
		if err != nil {
			return mcpFailureResult("internal_error", "failed to load Worker plugins", nil), nil
		}
		return mcpJSONResult(plugins), nil

	case "plugin_call":
		var input mcpPluginCallInput
		if err := decodeMCPToolInput(args, &input); err != nil || input.Worker == "" || input.PluginID == "" || input.ToolName == "" {
			return mcpToolCallResult{}, &mcpToolFailure{Message: "worker, plugin_id, and tool_name are required"}
		}
		if input.Arguments == nil {
			input.Arguments = map[string]interface{}{}
		}
		if input.TimeoutSeconds == 0 {
			input.TimeoutSeconds = 120
		}
		if input.TimeoutSeconds < 1 || input.TimeoutSeconds > 3600 {
			return mcpToolCallResult{}, &mcpToolFailure{Message: "timeout_seconds must be between 1 and 3600"}
		}
		return s.mcpPluginCall(ctx, authCtx, input), nil

	case "task_get":
		var input mcpTaskInput
		if err := decodeMCPToolInput(args, &input); err != nil || input.TaskID == "" {
			return mcpToolCallResult{}, &mcpToolFailure{Message: "task_id is required"}
		}
		task, failure := s.mcpOwnedTask(authCtx, input.TaskID)
		if failure != nil {
			return mcpFailureResult(failure.Code, failure.Message, failure.Details), nil
		}
		return mcpJSONResult(toTaskResponse(task)), nil

	case "task_wait":
		var input mcpTaskWaitInput
		if err := decodeMCPToolInput(args, &input); err != nil || input.TaskID == "" {
			return mcpToolCallResult{}, &mcpToolFailure{Message: "task_id is required"}
		}
		if input.TimeoutSeconds == 0 {
			input.TimeoutSeconds = 30
		}
		if input.TimeoutSeconds < 1 || input.TimeoutSeconds > 60 {
			return mcpToolCallResult{}, &mcpToolFailure{Message: "timeout_seconds must be between 1 and 60"}
		}
		task, failure := s.mcpWaitTask(ctx, authCtx, input.TaskID, time.Duration(input.TimeoutSeconds)*time.Second)
		if failure != nil {
			return mcpFailureResult(failure.Code, failure.Message, failure.Details), nil
		}
		return mcpJSONResult(toTaskResponse(task)), nil

	case "task_cancel":
		var input mcpTaskInput
		if err := decodeMCPToolInput(args, &input); err != nil || input.TaskID == "" {
			return mcpToolCallResult{}, &mcpToolFailure{Message: "task_id is required"}
		}
		task, failure := s.mcpCancelTask(authCtx, input.TaskID)
		if failure != nil {
			return mcpFailureResult(failure.Code, failure.Message, failure.Details), nil
		}
		return mcpJSONResult(toTaskResponse(task)), nil

	default:
		return mcpToolCallResult{}, &mcpToolFailure{Message: "unknown tool: " + name}
	}
}

func (s *Server) mcpListWorkers(authCtx *AuthContext) (*workerListResponse, error) {
	workers, err := s.store.ListWorkersByOwner(authCtx.UserID)
	if err != nil {
		return nil, err
	}
	owner, err := s.store.GetUserByID(authCtx.UserID)
	if err != nil || owner == nil {
		return nil, err
	}
	items := make([]workerListItem, 0, len(workers))
	for _, worker := range workers {
		if worker.RevokedAt.Valid {
			continue
		}
		items = append(items, workerListItemFromRow(worker, owner.Username))
	}
	return &workerListResponse{Items: items, Total: len(items)}, nil
}

func (s *Server) mcpResolveWorker(authCtx *AuthContext, selector string) (*store.WorkerRow, *mcpToolFailure) {
	workers, err := s.store.ListWorkersByOwner(authCtx.UserID)
	if err != nil {
		return nil, &mcpToolFailure{Code: "internal_error", Message: "failed to resolve Worker"}
	}
	for _, worker := range workers {
		if worker.RevokedAt.Valid {
			continue
		}
		if worker.WorkerID == selector || worker.WorkerName == selector {
			return worker, nil
		}
	}
	return nil, &mcpToolFailure{Code: domain.ErrWorkerNotFound, Message: "Worker not found"}
}

func (s *Server) mcpOwnedTask(authCtx *AuthContext, taskID string) (*domain.Task, *mcpToolFailure) {
	task := s.taskStore.Get(taskID)
	if task == nil {
		return nil, &mcpToolFailure{Code: domain.ErrNotFound, Message: "task not found"}
	}
	if task.OwnerUserID != authCtx.UserID {
		return nil, &mcpToolFailure{Code: domain.ErrForbidden, Message: "task does not belong to the authenticated user"}
	}
	return task, nil
}

func (s *Server) mcpPluginCall(ctx context.Context, authCtx *AuthContext, input mcpPluginCallInput) mcpToolCallResult {
	worker, failure := s.mcpResolveWorker(authCtx, input.Worker)
	if failure != nil {
		return mcpFailureResult(failure.Code, failure.Message, failure.Details)
	}
	if !s.isWorkerOnline(worker.WorkerID) {
		return mcpFailureResult(domain.ErrWorkerOffline, "Worker is not connected", nil)
	}

	task := &domain.Task{
		TaskID:       domain.GenerateTaskID(),
		TargetWorker: worker.WorkerID,
		TaskType:     "plugin_call",
		Params: map[string]interface{}{
			"plugin_id": input.PluginID,
			"tool_name": input.ToolName,
			"arguments": input.Arguments,
		},
		Status:        domain.TaskPending,
		TimeoutSecond: input.TimeoutSeconds,
		CreatedAt:     domain.NowISO(),
		OwnerUserID:   authCtx.UserID,
	}
	pending := s.taskStore.RegisterPending(task.TaskID)
	s.taskStore.EnqueuePending(task)
	s.wakeWorker(worker.WorkerID)

	waitFor := time.Duration(input.TimeoutSeconds) * time.Second
	if waitFor > 60*time.Second {
		waitFor = 60 * time.Second
	}
	timer := time.NewTimer(waitFor)
	select {
	case <-pending:
		timer.Stop()
	case <-timer.C:
	case <-ctx.Done():
		timer.Stop()
	}
	s.taskStore.UnregisterPending(task.TaskID)

	task = s.taskStore.Get(task.TaskID)
	if task == nil {
		return mcpFailureResult(domain.ErrInternal, "task disappeared", nil)
	}
	if task.Status == domain.TaskCompleted {
		return mcpPluginResult(task)
	}
	if task.Status == domain.TaskPending || task.Status == domain.TaskRunning {
		return mcpJSONResult(toTaskResponse(task))
	}
	return mcpTaskFailureResult(task)
}

func (s *Server) mcpWaitTask(ctx context.Context, authCtx *AuthContext, taskID string, timeout time.Duration) (*domain.Task, *mcpToolFailure) {
	task, failure := s.mcpOwnedTask(authCtx, taskID)
	if failure != nil || isMCPTaskTerminal(task.Status) {
		return task, failure
	}
	timer := time.NewTimer(timeout)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer timer.Stop()
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return s.taskStore.Get(taskID), nil
		case <-timer.C:
			return s.taskStore.Get(taskID), nil
		case <-ticker.C:
			task, failure = s.mcpOwnedTask(authCtx, taskID)
			if failure != nil || isMCPTaskTerminal(task.Status) {
				return task, failure
			}
		}
	}
}

func (s *Server) mcpCancelTask(authCtx *AuthContext, taskID string) (*domain.Task, *mcpToolFailure) {
	task, failure := s.mcpOwnedTask(authCtx, taskID)
	if failure != nil {
		return nil, failure
	}
	if isMCPTaskTerminal(task.Status) {
		return task, nil
	}
	if task.Status == domain.TaskPending {
		canceled, ok := s.taskStore.CancelPending(taskID)
		if ok {
			return canceled, nil
		}
		task = s.taskStore.Get(taskID)
		if task == nil {
			return nil, &mcpToolFailure{Code: domain.ErrNotFound, Message: "task not found"}
		}
		if isMCPTaskTerminal(task.Status) {
			return task, nil
		}
	}
	if !s.isWorkerOnline(task.TargetWorker) {
		return nil, &mcpToolFailure{Code: domain.ErrWorkerOffline, Message: "Worker is not connected"}
	}
	canceled, ok := s.taskStore.EnqueueCancel(taskID)
	if !ok {
		return s.taskStore.Get(taskID), nil
	}
	s.wakeWorker(task.TargetWorker)
	return canceled, nil
}

func isMCPTaskTerminal(status domain.TaskStatus) bool {
	switch status {
	case domain.TaskCompleted, domain.TaskFailed, domain.TaskTimeout, domain.TaskCanceled:
		return true
	default:
		return false
	}
}

func mcpJSONResult(value interface{}) mcpToolCallResult {
	raw, err := json.Marshal(value)
	if err != nil {
		return mcpFailureResult(domain.ErrInternal, "failed to encode tool result", nil)
	}
	return mcpToolCallResult{Content: []mcpContent{{Type: "text", Text: string(raw)}}}
}

func mcpFailureResult(code, message string, details interface{}) mcpToolCallResult {
	payload := map[string]interface{}{
		"code":    code,
		"message": message,
		"details": details,
	}
	raw, _ := json.Marshal(payload)
	return mcpToolCallResult{
		IsError: true,
		Content: []mcpContent{{Type: "text", Text: string(raw)}},
	}
}

func mcpTaskFailureResult(task *domain.Task) mcpToolCallResult {
	if task.Error != nil {
		return mcpFailureResult(task.Error.Code, task.Error.Message, task.Error.Details)
	}
	return mcpFailureResult(string(task.Status), "task ended with status "+string(task.Status), map[string]string{
		"task_id": task.TaskID,
	})
}

func mcpPluginResult(task *domain.Task) mcpToolCallResult {
	var pluginResult domain.PluginCallResult
	raw, err := json.Marshal(task.Result)
	if err != nil || json.Unmarshal(raw, &pluginResult) != nil {
		return mcpJSONResult(toTaskResponse(task))
	}
	result := mcpToolCallResult{IsError: pluginResult.IsError}
	for _, block := range pluginResult.Content {
		if block.Type == "json" {
			encoded, err := json.Marshal(block.Value)
			if err != nil {
				encoded = []byte("null")
			}
			result.Content = append(result.Content, mcpContent{Type: "text", Text: string(encoded)})
			continue
		}
		result.Content = append(result.Content, mcpContent{Type: "text", Text: block.Text})
	}
	if len(result.Content) == 0 {
		result.Content = []mcpContent{{Type: "text", Text: ""}}
	}
	if pluginResult.StructuredContent != nil {
		result.StructuredContent = pluginResult.StructuredContent
	}
	return result
}
