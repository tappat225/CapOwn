package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/capown/master/internal/domain"
	"github.com/capown/master/internal/store"
)

type patchWorkerRequest struct {
	WorkerName string `json:"worker_name"`
}

type workerListItem struct {
	WorkerID           string              `json:"worker_id"`
	WorkerName         string              `json:"worker_name"`
	OwnerUserID        string              `json:"owner_user_id"`
	OwnerUsername      string              `json:"owner_username"`
	Hostname           string              `json:"hostname"`
	OS                 string              `json:"os"`
	Mode               string              `json:"mode"`
	Capabilities       []string            `json:"capabilities"`
	Workspace          string              `json:"workspace"`
	Status             string              `json:"status"`
	LastHeartbeat      *string             `json:"last_heartbeat"`
	RegisteredAt       *string             `json:"registered_at"`
	PreviousWorkerName *string             `json:"previous_worker_name"`
	RenamedAt          *string             `json:"renamed_at"`
	Plugins            []domain.PluginInfo `json:"plugins,omitempty"`
}

type workerListResponse struct {
	Items []workerListItem `json:"items"`
	Total int              `json:"total"`
}

func capabilitiesToSlice(capStr string) []string {
	if capStr == "" {
		return []string{}
	}
	parts := strings.Split(capStr, ",")
	result := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			result = append(result, p)
		}
	}
	return result
}

func strPtr(s string, valid bool) *string {
	if !valid || s == "" {
		return nil
	}
	return &s
}

func pluginsToSlice(raw string) []domain.PluginInfo {
	if raw == "" {
		return []domain.PluginInfo{}
	}
	var plugins []domain.PluginInfo
	if err := json.Unmarshal([]byte(raw), &plugins); err != nil || len(plugins) == 0 {
		return []domain.PluginInfo{}
	}
	return plugins
}

func workerListItemFromRow(w *store.WorkerRow, ownerUsername string) workerListItem {
	return workerListItem{
		WorkerID:           w.WorkerID,
		WorkerName:         w.WorkerName,
		OwnerUserID:        w.OwnerUserID,
		OwnerUsername:      ownerUsername,
		Hostname:           w.Hostname,
		OS:                 w.OS,
		Mode:               w.Mode,
		Capabilities:       capabilitiesToSlice(w.Capabilities),
		Workspace:          w.Workspace,
		Status:             w.Status,
		LastHeartbeat:      strPtr(w.LastHeartbeat.String, w.LastHeartbeat.Valid),
		RegisteredAt:       strPtr(w.RegisteredAt.String, w.RegisteredAt.Valid),
		PreviousWorkerName: strPtr(w.PreviousWorkerName.String, w.PreviousWorkerName.Valid),
		RenamedAt:          strPtr(w.RenamedAt.String, w.RenamedAt.Valid),
		Plugins:            pluginsToSlice(w.Plugins.String),
	}
}

func (s *Server) handleListWorkers(w http.ResponseWriter, r *http.Request) {
	ctx, apiErr := s.resolveAPI(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	workers, err := s.store.ListWorkersByOwner(ctx.UserID)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	s.writeWorkerList(w, workers)
}

func (s *Server) handleAdminListWorkers(w http.ResponseWriter, r *http.Request) {
	_, apiErr := s.resolveAdminToken(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	workers, err := s.store.ListAllWorkers()
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	s.writeWorkerList(w, workers)
}

func (s *Server) writeWorkerList(w http.ResponseWriter, workers []*store.WorkerRow) {
	items := make([]workerListItem, 0, len(workers))
	users, err := s.store.ListUsers()
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	ownerNames := make(map[string]string, len(users))
	for _, user := range users {
		ownerNames[user.UserID] = user.Username
	}
	for _, w := range workers {
		// Skip revoked workers in normal listings
		if w.RevokedAt.Valid {
			continue
		}
		items = append(items, workerListItemFromRow(w, ownerNames[w.OwnerUserID]))
	}

	writeJSON(w, http.StatusOK, workerListResponse{Items: items, Total: len(items)})
}

func (s *Server) handleGetWorker(w http.ResponseWriter, r *http.Request) {
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

	// Check ownership (admins see all)
	if ctx.UserID != worker.OwnerUserID && !ctx.hasAdminScope() {
		writeErrorCode(w, http.StatusForbidden, domain.ErrForbidden, "not your worker")
		return
	}

	owner, err := s.store.GetUserByID(worker.OwnerUserID)
	if err != nil || owner == nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	writeJSON(w, http.StatusOK, workerListItemFromRow(worker, owner.Username))
}

func (s *Server) handlePatchWorker(w http.ResponseWriter, r *http.Request) {
	workerID := r.PathValue("worker_id")
	if workerID == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "worker_id is required")
		return
	}

	ctx, apiErr := s.resolveWebSession(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	var req patchWorkerRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}

	if req.WorkerName == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "worker_name is required")
		return
	}
	if msg := domain.ValidateWorkerName(req.WorkerName); msg != "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrWorkerNameInvalid, msg)
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
	if ctx.Role != "admin" && worker.OwnerUserID != ctx.UserID {
		writeErrorCode(w, http.StatusForbidden, domain.ErrForbidden, "not your worker")
		return
	}

	if err := s.store.RenameWorkerAtomic(workerID, worker.OwnerUserID, req.WorkerName); err != nil {
		if errors.Is(err, store.ErrWorkerNotFound) {
			writeErrorCode(w, http.StatusNotFound, domain.ErrWorkerNotFound, "worker not found")
		} else {
			slog.Warn("failed to rename worker", "worker_id", workerID, "error", err)
			writeErrorCode(w, http.StatusConflict, domain.ErrConflict, "worker name already taken")
		}
		return
	}

	// Notify dashboard
	s.dashBus.PublishByWorker(workerID, "worker.updated",
		map[string]interface{}{
			"worker_id":   workerID,
			"worker_name": req.WorkerName,
		}, func(wid string) (string, error) {
			o, err := s.store.GetOwner(wid)
			if err != nil || o == nil {
				return "", err
			}
			return o.UserID, nil
		})

	writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

func (s *Server) handleDeleteWorker(w http.ResponseWriter, r *http.Request) {
	workerID := r.PathValue("worker_id")
	if workerID == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "worker_id is required")
		return
	}

	ctx, apiErr := s.resolveWebSession(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	// Check ownership (capture owner ID for event publishing before revoke)
	ownerID := ctx.UserID
	if ctx.Role != "admin" {
		isOwner, err := s.store.IsOwner(ctx.UserID, workerID)
		if err != nil || !isOwner {
			writeErrorCode(w, http.StatusForbidden, domain.ErrForbidden, "not your worker")
			return
		}
	} else {
		// For admin, look up the owner before revoke
		owner, err := s.store.GetOwner(workerID)
		if err == nil && owner != nil {
			ownerID = owner.UserID
		}
	}

	// Atomic revoke
	if err := s.store.RevokeWorkerAtomic(workerID, ownerID); err != nil {
		if errors.Is(err, store.ErrWorkerNotFound) {
			writeErrorCode(w, http.StatusNotFound, domain.ErrWorkerNotFound, "worker not found")
		} else {
			writeError(w, domain.ErrInternalResponse)
		}
		return
	}

	// Clean up in-memory state
	s.challenges.RevokeWorker(workerID)
	s.workerSessions.RevokeWorker(workerID)
	s.taskStore.BlockWorker(workerID)

	// Notify dashboard — ownerID is captured from before revoke
	s.dashBus.PublishWorker(ownerID, "worker.revoked", map[string]string{
		"worker_id": workerID,
	})

	w.WriteHeader(http.StatusNoContent)
}
