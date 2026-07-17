package httpapi

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/capown/master/internal/domain"
)

type createRegistrationRequest struct {
	Label     string `json:"label"`
	ExpiresIn int    `json:"expires_in"`
	MaxUses   int    `json:"max_uses"`
}

func (s *Server) buildRegistrationURL(token string) string {
	baseURL := strings.TrimRight(strings.TrimSpace(s.config.Master.PublicURL), "/")
	if baseURL == "" {
		return ""
	}
	return baseURL + "/v1/worker-registrations/" + url.PathEscape(token)
}

func (s *Server) handleListRegistrations(w http.ResponseWriter, r *http.Request) {
	ctx, apiErr := s.resolveWebSession(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	tokens, err := s.store.ListRegistrationTokens(ctx.UserID)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}

	type view struct {
		TokenID     string `json:"token_id"`
		TokenPrefix string `json:"token_prefix"`
		Scope       string `json:"scope"`
		ExpiresAt   string `json:"expires_at"`
		MaxUses     int    `json:"max_uses"`
		UsedCount   int    `json:"used_count"`
		RevokedAt   string `json:"revoked_at,omitempty"`
		CreatedAt   string `json:"created_at"`
		Label       string `json:"label"`
	}

	views := make([]view, 0, len(tokens))
	for _, t := range tokens {
		v := view{
			TokenID:     t.TokenID,
			TokenPrefix: t.TokenPrefix,
			Scope:       t.Scope,
			ExpiresAt:   t.ExpiresAt,
			MaxUses:     t.MaxUses,
			UsedCount:   t.UsedCount,
			CreatedAt:   t.CreatedAt,
			Label:       t.Label,
		}
		if t.RevokedAt.Valid {
			v.RevokedAt = t.RevokedAt.String
		}
		views = append(views, v)
	}

	writeJSON(w, http.StatusOK, views)
}

func (s *Server) handleCreateRegistration(w http.ResponseWriter, r *http.Request) {
	ctx, apiErr := s.resolveWebSession(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	var req createRegistrationRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}

	// Defaults
	if req.ExpiresIn <= 0 {
		req.ExpiresIn = 86400 // 24 hours
	}
	if req.MaxUses <= 0 {
		req.MaxUses = 1
	}

	plaintext, token, err := s.store.CreateRegistrationToken(ctx.UserID, req.ExpiresIn, req.MaxUses, req.Label)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}

	resp := map[string]interface{}{
		"token_id":           token.TokenID,
		"registration_token": plaintext,
		"token_prefix":       token.TokenPrefix,
		"scope":             token.Scope,
		"expires_at":        token.ExpiresAt,
		"max_uses":          token.MaxUses,
		"label":             token.Label,
		"created_at":        token.CreatedAt,
	}

	// Generate registration URL if public_url is configured.
	if registrationURL := s.buildRegistrationURL(plaintext); registrationURL != "" {
		resp["registration_url"] = registrationURL
	}

	writeJSON(w, http.StatusCreated, resp)
}

func (s *Server) handleDeleteRegistration(w http.ResponseWriter, r *http.Request) {
	ctx, apiErr := s.resolveWebSession(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	registrationID := r.PathValue("registration_id")
	if registrationID == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "registration_id is required")
		return
	}

	// Verify ownership
	tok, err := s.store.GetRegistrationTokenByID(registrationID)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	if tok == nil {
		writeErrorCode(w, http.StatusNotFound, domain.ErrNotFound, "registration token not found")
		return
	}
	if tok.UserID != ctx.UserID {
		writeErrorCode(w, http.StatusForbidden, domain.ErrForbidden, "not your registration token")
		return
	}

	if err := s.store.RevokeRegistrationToken(registrationID); err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
