package httpapi

import (
	"net/http"

	"github.com/capown/master/internal/domain"
	"github.com/capown/master/internal/store"
)

type createTokenRequest struct {
	Type  string `json:"type"`
	Label string `json:"label"`
}

type updateTokenRequest struct {
	Status string `json:"status"`
}

type tokenView struct {
	TokenID     string  `json:"token_id"`
	TokenType   string  `json:"token_type"`
	TokenPrefix string  `json:"token_prefix"`
	Label       string  `json:"label"`
	CreatedAt   string  `json:"created_at"`
	ExpiresAt   *string `json:"expires_at"`
	LastUsedAt  *string `json:"last_used_at"`
	LastUsedIP  *string `json:"last_used_ip"`
	DisabledAt  *string `json:"disabled_at"`
	RevokedAt   *string `json:"revoked_at"`
	Status      string  `json:"status"`
}

func tokenStatus(t *store.TokenRow) string {
	if t.RevokedAt.Valid {
		return "revoked"
	}
	if t.DisabledAt.Valid {
		return "disabled"
	}
	return "active"
}

func makeTokenView(t *store.TokenRow) tokenView {
	return tokenView{
		TokenID:     t.TokenID,
		TokenType:   t.TokenType,
		TokenPrefix: t.TokenPrefix,
		Label:       t.Name,
		CreatedAt:   t.CreatedAt,
		ExpiresAt:   nil,
		LastUsedAt:  strPtr(t.LastUsedAt.String, t.LastUsedAt.Valid),
		LastUsedIP:  strPtr(t.LastUsedIP.String, t.LastUsedIP.Valid),
		DisabledAt:  strPtr(t.DisabledAt.String, t.DisabledAt.Valid),
		RevokedAt:   strPtr(t.RevokedAt.String, t.RevokedAt.Valid),
		Status:      tokenStatus(t),
	}
}

func (s *Server) handleListTokens(w http.ResponseWriter, r *http.Request) {
	ctx, apiErr := s.resolveWebSession(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	tokenType := r.URL.Query().Get("type")

	var tokens []*store.TokenRow
	var err error
	if tokenType == "client" {
		tokens, err = s.store.ListOwnedClientTokens(ctx.UserID)
	} else {
		tokens, err = s.store.ListUserTokens(ctx.UserID)
	}
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}

	views := make([]tokenView, 0, len(tokens))
	for _, t := range tokens {
		views = append(views, makeTokenView(t))
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"items": views,
		"total": len(views),
	})
}

func (s *Server) handlePatchToken(w http.ResponseWriter, r *http.Request) {
	ctx, apiErr := s.resolveWebSession(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	tokenID := r.PathValue("token_id")
	if tokenID == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "token_id is required")
		return
	}

	var req updateTokenRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}
	if req.Status != "active" && req.Status != "disabled" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "status must be 'active' or 'disabled'")
		return
	}

	tok, err := s.store.GetTokenByID(tokenID)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	if tok == nil {
		writeErrorCode(w, http.StatusNotFound, domain.ErrNotFound, "token not found")
		return
	}
	if tok.UserID != ctx.UserID {
		writeErrorCode(w, http.StatusForbidden, domain.ErrForbidden, "not your token")
		return
	}
	if tok.TokenType != "client" {
		writeErrorCode(w, http.StatusForbidden, domain.ErrForbidden, "only client tokens can be disabled")
		return
	}
	if tok.RevokedAt.Valid {
		writeErrorCode(w, http.StatusConflict, domain.ErrConflict, "revoked tokens cannot be enabled or disabled")
		return
	}

	if err := s.store.SetTokenDisabled(tokenID, req.Status == "disabled"); err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	updated, err := s.store.GetTokenByID(tokenID)
	if err != nil || updated == nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	writeJSON(w, http.StatusOK, makeTokenView(updated))
}

func (s *Server) handleCreateToken(w http.ResponseWriter, r *http.Request) {
	ctx, apiErr := s.resolveWebSession(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	var req createTokenRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}

	// Default to client type
	tokenType := req.Type
	if tokenType == "" {
		tokenType = "client"
	}
	if tokenType != "client" && tokenType != "admin" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "token type must be 'client' or 'admin'")
		return
	}

	// Only admins can create admin tokens
	if tokenType == "admin" && ctx.Role != "admin" {
		writeErrorCode(w, http.StatusForbidden, domain.ErrForbidden, "admin access required")
		return
	}

	plaintext, token, err := s.store.CreateToken(ctx.UserID, tokenType, req.Label)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"token_id":     token.TokenID,
		"token":        plaintext,
		"token_type":   token.TokenType,
		"token_prefix": token.TokenPrefix,
		"label":        token.Name,
		"created_at":   token.CreatedAt,
	})
}

func (s *Server) handleDeleteToken(w http.ResponseWriter, r *http.Request) {
	ctx, apiErr := s.resolveWebSession(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	tokenID := r.PathValue("token_id")
	if tokenID == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "token_id is required")
		return
	}

	// Verify ownership
	tok, err := s.store.GetTokenByID(tokenID)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	if tok == nil {
		writeErrorCode(w, http.StatusNotFound, domain.ErrNotFound, "token not found")
		return
	}
	if tok.UserID != ctx.UserID {
		writeErrorCode(w, http.StatusForbidden, domain.ErrForbidden, "not your token")
		return
	}

	if err := s.store.RevokeToken(tokenID); err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
