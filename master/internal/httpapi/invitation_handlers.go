package httpapi

import (
	"net/http"
	"time"

	"github.com/capown/master/internal/domain"
	"github.com/capown/master/internal/store"
)

const invitationTTL = 7 * 24 * time.Hour

type createInvitationRequest struct {
	Label string `json:"label"`
}

func invitationView(row *store.InvitationRow) map[string]interface{} {
	view := map[string]interface{}{
		"invitation_id": row.InvitationID,
		"code_prefix":   row.CodePrefix,
		"label":         row.Label,
		"created_by":    row.CreatedBy,
		"created_at":    row.CreatedAt,
		"expires_at":    row.ExpiresAt,
		"used_at":       nil,
		"used_by":       nil,
		"revoked_at":    nil,
		"status":        store.InvitationStatus(row, time.Now().UTC()),
	}
	if row.UsedAt.Valid {
		view["used_at"] = row.UsedAt.String
	}
	if row.UsedBy.Valid {
		view["used_by"] = row.UsedBy.String
	}
	if row.RevokedAt.Valid {
		view["revoked_at"] = row.RevokedAt.String
	}
	return view
}

func (s *Server) handleAdminListInvitations(w http.ResponseWriter, r *http.Request) {
	if _, apiErr := s.resolveAdminToken(r); apiErr != nil {
		writeError(w, apiErr)
		return
	}
	rows, err := s.store.ListInvitations()
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	views := make([]map[string]interface{}, 0, len(rows))
	for _, row := range rows {
		views = append(views, invitationView(row))
	}
	writeJSON(w, http.StatusOK, views)
}

func (s *Server) handleAdminCreateInvitation(w http.ResponseWriter, r *http.Request) {
	ctx, apiErr := s.resolveAdminToken(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}
	var req createInvitationRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}
	if len(req.Label) > 120 {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "label must not exceed 120 characters")
		return
	}
	code, row, err := s.store.CreateInvitation(ctx.UserID, req.Label, invitationTTL)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	view := invitationView(row)
	view["invitation_code"] = code
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, view)
}

func (s *Server) handleAdminRevokeInvitation(w http.ResponseWriter, r *http.Request) {
	if _, apiErr := s.resolveAdminToken(r); apiErr != nil {
		writeError(w, apiErr)
		return
	}
	invitationID := r.PathValue("invitation_id")
	if invitationID == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "invitation_id is required")
		return
	}
	revoked, err := s.store.RevokeInvitation(invitationID)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	if !revoked {
		writeErrorCode(w, http.StatusNotFound, domain.ErrNotFound, "invitation not found or no longer active")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
