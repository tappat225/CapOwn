package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/capown/master/internal/auth"
	"github.com/capown/master/internal/domain"
)

// Worker registration request
type workerRegisterRequest struct {
	RegistrationToken string   `json:"registration_token"`
	WorkerName        string   `json:"worker_name"`
	PublicKey         string   `json:"public_key"`
	Hostname          string   `json:"hostname"`
	OS                string   `json:"os"`
	Mode              string   `json:"mode"`
	Capabilities      []string `json:"capabilities"`
	Workspace         string   `json:"workspace"`
}

// Worker auth challenge request
type authChallengeRequest struct {
	WorkerID string `json:"worker_id"`
}

// Worker auth session request
type authSessionRequest struct {
	WorkerID  string `json:"worker_id"`
	Nonce     string `json:"nonce"`
	Signature string `json:"signature"`
}

// Runtime update request
type runtimeUpdateRequest struct {
	Hostname     string               `json:"hostname"`
	OS           string               `json:"os"`
	Mode         string               `json:"mode"`
	Capabilities []string             `json:"capabilities"`
	Workspace    string               `json:"workspace"`
	Plugins      *[]domain.PluginInfo `json:"plugins,omitempty"`
}

func (s *Server) handleRegisterWorker(w http.ResponseWriter, r *http.Request) {
	var req workerRegisterRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}
	// Validate required fields
	if req.RegistrationToken == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "registration_token is required")
		return
	}
	if req.WorkerName == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "worker_name is required")
		return
	}
	if req.PublicKey == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "public_key is required")
		return
	}
	if !auth.ValidEd25519PublicKey(req.PublicKey) {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "public_key must be a 32-byte Ed25519 key encoded as hex")
		return
	}

	// Validate worker name
	if msg := domain.ValidateWorkerName(req.WorkerName); msg != "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrWorkerNameInvalid, msg)
		return
	}

	// Slice/fill defaults
	mode := req.Mode
	if mode == "" {
		mode = "capability"
	}
	capStr := strings.Join(req.Capabilities, ",")
	workspace := req.Workspace

	// Atomic registration
	workerID, errCode, err := s.store.RegisterWorkerAtomic(
		req.RegistrationToken, req.WorkerName, req.Hostname, req.PublicKey,
		req.OS, mode, capStr, workspace,
	)
	if err != nil {
		switch errCode {
		case "registration_invalid":
			writeErrorCode(w, http.StatusUnauthorized, domain.ErrRegistrationInvalid, "invalid registration token")
		case "registration_expired":
			writeErrorCode(w, http.StatusUnauthorized, domain.ErrRegistrationExpired, "registration token expired")
		case "registration_exhausted":
			writeErrorCode(w, http.StatusConflict, domain.ErrRegistrationExhausted, "registration token exhausted")
		case "conflict":
			writeErrorCode(w, http.StatusConflict, domain.ErrConflict, "worker name already taken")
		default:
			slog.Error("registration failed", "error", err)
			writeError(w, domain.ErrInternalResponse)
		}
		return
	}

	// Notify dashboard
	owner, _ := s.store.GetOwner(workerID)
	if owner != nil {
		s.dashBus.PublishWorker(owner.UserID, "worker.registered", map[string]interface{}{
			"worker_id":   workerID,
			"worker_name": req.WorkerName,
		})
	}

	writeJSON(w, http.StatusCreated, map[string]string{
		"worker_id":   workerID,
		"worker_name": req.WorkerName,
	})
}

func (s *Server) handleAuthChallenge(w http.ResponseWriter, r *http.Request) {
	var req authChallengeRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}

	if req.WorkerID == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "worker_id is required")
		return
	}

	// Verify worker exists and is active
	worker, err := s.store.GetActiveWorker(req.WorkerID)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	if worker == nil {
		writeErrorCode(w, http.StatusNotFound, domain.ErrWorkerNotFound, "worker not found")
		return
	}

	// Verify public key exists
	if worker.PublicKey == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "worker has no public key")
		return
	}

	// Create challenge
	nonce, expiresAt := s.challenges.Create(req.WorkerID)

	writeJSON(w, http.StatusOK, map[string]string{
		"nonce":      nonce,
		"expires_at": expiresAt,
	})
}

func (s *Server) handleAuthSession(w http.ResponseWriter, r *http.Request) {
	var req authSessionRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}

	if req.WorkerID == "" || req.Nonce == "" || req.Signature == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "worker_id, nonce, and signature are required")
		return
	}

	// Validate nonce
	if !s.challenges.Validate(req.Nonce, req.WorkerID) {
		writeErrorCode(w, http.StatusUnauthorized, domain.ErrSignatureInvalid, "invalid or expired nonce")
		return
	}

	// Get worker's public key
	pubKey, err := s.store.GetPublicKey(req.WorkerID)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	if pubKey == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "worker has no public key")
		return
	}

	// Verify Ed25519 signature
	if !auth.VerifyEd25519(pubKey, req.Nonce, req.Signature) {
		writeErrorCode(w, http.StatusUnauthorized, domain.ErrSignatureInvalid, "signature verification failed")
		return
	}

	// Look up owner
	owner, err := s.store.GetOwner(req.WorkerID)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	if owner == nil {
		writeErrorCode(w, http.StatusNotFound, domain.ErrForbidden, "worker owner not found")
		return
	}

	// Verify owner is active
	ownerUser, err := s.store.GetUserByID(owner.UserID)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	if ownerUser == nil || ownerUser.Status != "active" {
		writeErrorCode(w, http.StatusForbidden, domain.ErrUserDisabled, "worker owner is disabled")
		return
	}

	// Create worker session
	sessionToken := s.workerSessions.Create(req.WorkerID, owner.UserID, ownerUser.Username)

	writeJSON(w, http.StatusOK, map[string]string{
		"status":        "ok",
		"session_token": sessionToken,
	})
}

func (s *Server) handleUpdateRuntime(w http.ResponseWriter, r *http.Request) {
	workerID := r.PathValue("worker_id")

	// Authenticate with worker session
	ctx, apiErr := s.resolveWorkerSession(r, workerID)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	var req runtimeUpdateRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}
	if req.Plugins == nil {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "plugins is required")
		return
	}

	capStr := strings.Join(req.Capabilities, ",")
	mode := req.Mode
	if mode == "" {
		mode = "capability"
	}

	pluginsStr := ""
	for _, plugin := range *req.Plugins {
		if plugin.PluginID == "" || plugin.Version == "" || plugin.Kind == "" || plugin.Transport == "" {
			writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "plugin metadata is incomplete")
			return
		}
		switch plugin.Status {
		case "starting", "running", "stopped", "error", "disabled":
		default:
			writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "invalid plugin status")
			return
		}
		for _, tool := range plugin.Tools {
			if tool.Name == "" {
				writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "plugin tool name is required")
				return
			}
		}
	}
	encoded, err := json.Marshal(req.Plugins)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	pluginsStr = string(encoded)
	previousWorker, _ := s.store.GetActiveWorker(workerID)

	_, becameOnline, err := s.store.ReconnectWorker(workerID, req.Hostname, req.OS, mode, capStr, req.Workspace, pluginsStr)
	if err != nil {
		slog.Error("runtime update failed", "worker_id", workerID, "error", err)
		writeErrorCode(w, http.StatusNotFound, domain.ErrWorkerNotFound, "worker not found")
		return
	}

	if becameOnline {
		s.dashBus.PublishWorker(ctx.UserID, "worker.online", map[string]string{
			"worker_id": workerID,
		})
	}
	if previousWorker == nil || !previousWorker.Plugins.Valid || previousWorker.Plugins.String != pluginsStr {
		s.dashBus.PublishWorker(ctx.UserID, "worker.plugins_updated", map[string]string{
			"worker_id": workerID,
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
