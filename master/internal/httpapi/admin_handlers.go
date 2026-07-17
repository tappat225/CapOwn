package httpapi

import (
	"net/http"

	"github.com/capown/master/internal/domain"
	"github.com/capown/master/internal/store"
)

// adminCreateUserRequest is the request body for creating a user via admin API.
type adminCreateUserRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Role     string `json:"role"`
}

// adminPatchUserRequest is the request body for updating a user via admin API.
type adminPatchUserRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Role     string `json:"role"`
	Status   string `json:"status"`
}

func (s *Server) handleAdminListUsers(w http.ResponseWriter, r *http.Request) {
	_, apiErr := s.resolveAdminToken(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	users, err := s.store.ListUsers()
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}

	views := make([]map[string]interface{}, 0, len(users))
	for _, u := range users {
		views = append(views, store.UserToDomain(u))
	}

	writeJSON(w, http.StatusOK, views)
}

func (s *Server) handleAdminCreateUser(w http.ResponseWriter, r *http.Request) {
	_, apiErr := s.resolveAdminToken(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	var req adminCreateUserRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}

	if req.Username == "" || req.Password == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "username and password are required")
		return
	}
	if !hasMinimumPasswordLength(req.Password) {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "password must be at least 6 characters")
		return
	}

	role := req.Role
	if role == "" {
		role = "user"
	}
	if role != "user" && role != "admin" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "role must be 'user' or 'admin'")
		return
	}

	user, err := s.store.CreateUserWithPassword(req.Username, role, req.Password)
	if err != nil {
		writeErrorCode(w, http.StatusConflict, domain.ErrConflict, "username already taken")
		return
	}

	writeJSON(w, http.StatusCreated, store.UserToDomain(user))
}

func (s *Server) handleAdminGetUser(w http.ResponseWriter, r *http.Request) {
	_, apiErr := s.resolveAdminToken(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	username := r.PathValue("username")
	if username == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "username is required")
		return
	}

	user, err := s.store.GetUser(username)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	if user == nil {
		writeErrorCode(w, http.StatusNotFound, domain.ErrUserNotFound, "user not found")
		return
	}

	writeJSON(w, http.StatusOK, store.UserToDomain(user))
}

func (s *Server) handleAdminPatchUser(w http.ResponseWriter, r *http.Request) {
	_, apiErr := s.resolveAdminToken(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	username := r.PathValue("username")
	if username == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "username is required")
		return
	}

	user, err := s.store.GetUser(username)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	if user == nil {
		writeErrorCode(w, http.StatusNotFound, domain.ErrUserNotFound, "user not found")
		return
	}

	var req adminPatchUserRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}
	// Validate the complete patch before applying any field so invalid input
	// cannot leave a partially updated user.
	if req.Role != "" && req.Role != "user" && req.Role != "admin" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "role must be 'user' or 'admin'")
		return
	}
	if req.Status != "" && req.Status != "active" && req.Status != "disabled" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "status must be 'active' or 'disabled'")
		return
	}
	if req.Password != "" && !hasMinimumPasswordLength(req.Password) {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "password must be at least 6 characters")
		return
	}

	// Update username
	if req.Username != "" && req.Username != username {
		if err := s.store.RenameUser(user.UserID, req.Username); err != nil {
			writeErrorCode(w, http.StatusConflict, domain.ErrConflict, "username already taken")
			return
		}
	}

	// Update role
	if req.Role != "" && req.Role != user.Role {
		if err := s.store.SetUserRole(user.UserID, req.Role); err != nil {
			writeError(w, domain.ErrInternalResponse)
			return
		}
	}

	// Update status / disable
	if req.Status != "" && req.Status != user.Status {
		if err := s.store.SetUserStatus(user.UserID, req.Status); err != nil {
			writeError(w, domain.ErrInternalResponse)
			return
		}

		// Revoke all sessions when disabling
		if req.Status == "disabled" {
			s.store.RevokeAllUserSessions(user.UserID)
			s.workerSessions.RevokeUser(user.UserID)
		}
	}

	// Update password — revoke all sessions when admin changes password
	if req.Password != "" {
		if err := s.store.SetPassword(user.UserID, req.Password); err != nil {
			writeError(w, domain.ErrInternalResponse)
			return
		}
		// Admin forcing password reset: revoke all sessions
		s.store.RevokeAllUserSessions(user.UserID)
		s.workerSessions.RevokeUser(user.UserID)
	}

	// Return updated user
	updated, err := s.store.GetUser(req.Username)
	if err != nil || updated == nil {
		updated, _ = s.store.GetUser(username)
	}

	if updated != nil {
		writeJSON(w, http.StatusOK, store.UserToDomain(updated))
	} else {
		writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
	}
}

func (s *Server) handleAdminListUserTokens(w http.ResponseWriter, r *http.Request) {
	_, apiErr := s.resolveAdminToken(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	username := r.PathValue("username")
	if username == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "username is required")
		return
	}

	user, err := s.store.GetUser(username)
	if err != nil || user == nil {
		writeErrorCode(w, http.StatusNotFound, domain.ErrUserNotFound, "user not found")
		return
	}

	tokens, err := s.store.ListUserTokens(user.UserID)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}

	type tokenView struct {
		TokenID     string `json:"token_id"`
		TokenType   string `json:"token_type"`
		TokenPrefix string `json:"token_prefix"`
		Name        string `json:"name"`
		CreatedAt   string `json:"created_at"`
		LastUsedAt  string `json:"last_used_at,omitempty"`
		RevokedAt   string `json:"revoked_at,omitempty"`
	}

	views := make([]tokenView, 0, len(tokens))
	for _, t := range tokens {
		v := tokenView{
			TokenID:     t.TokenID,
			TokenType:   t.TokenType,
			TokenPrefix: t.TokenPrefix,
			Name:        t.Name,
			CreatedAt:   t.CreatedAt,
		}
		if t.LastUsedAt.Valid {
			v.LastUsedAt = t.LastUsedAt.String
		}
		if t.RevokedAt.Valid {
			v.RevokedAt = t.RevokedAt.String
		}
		views = append(views, v)
	}

	writeJSON(w, http.StatusOK, views)
}

func (s *Server) handleAdminCreateUserToken(w http.ResponseWriter, r *http.Request) {
	_, apiErr := s.resolveAdminToken(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	username := r.PathValue("username")
	if username == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "username is required")
		return
	}

	user, err := s.store.GetUser(username)
	if err != nil || user == nil {
		writeErrorCode(w, http.StatusNotFound, domain.ErrUserNotFound, "user not found")
		return
	}

	var req createTokenRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}

	tokenType := req.Type
	if tokenType == "" {
		tokenType = "client"
	}
	if tokenType != "client" && tokenType != "admin" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "token type must be 'client' or 'admin'")
		return
	}

	plaintext, token, err := s.store.CreateToken(user.UserID, tokenType, req.Label)
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

func (s *Server) handleAdminDeleteToken(w http.ResponseWriter, r *http.Request) {
	_, apiErr := s.resolveAdminToken(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	tokenID := r.PathValue("token_id")
	if tokenID == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "token_id is required")
		return
	}

	tok, err := s.store.GetTokenByID(tokenID)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	if tok == nil {
		writeErrorCode(w, http.StatusNotFound, domain.ErrTokenNotFound, "token not found")
		return
	}

	if err := s.store.RevokeToken(tokenID); err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleAdminListRegistrations(w http.ResponseWriter, r *http.Request) {
	_, apiErr := s.resolveAdminToken(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	username := r.PathValue("username")
	if username == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "username is required")
		return
	}

	user, err := s.store.GetUser(username)
	if err != nil || user == nil {
		writeErrorCode(w, http.StatusNotFound, domain.ErrUserNotFound, "user not found")
		return
	}

	tokens, err := s.store.ListRegistrationTokens(user.UserID)
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

func (s *Server) handleAdminCreateRegistration(w http.ResponseWriter, r *http.Request) {
	_, apiErr := s.resolveAdminToken(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	username := r.PathValue("username")
	if username == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "username is required")
		return
	}

	user, err := s.store.GetUser(username)
	if err != nil || user == nil {
		writeErrorCode(w, http.StatusNotFound, domain.ErrUserNotFound, "user not found")
		return
	}

	var req createRegistrationRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}

	if req.ExpiresIn <= 0 {
		req.ExpiresIn = 86400
	}
	if req.MaxUses <= 0 {
		req.MaxUses = 1
	}

	plaintext, token, err := s.store.CreateRegistrationToken(user.UserID, req.ExpiresIn, req.MaxUses, req.Label)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}

	resp := map[string]interface{}{
		"token_id":           token.TokenID,
		"registration_token": plaintext,
		"token_prefix":       token.TokenPrefix,
		"scope":              token.Scope,
		"expires_at":         token.ExpiresAt,
		"max_uses":           token.MaxUses,
		"label":              token.Label,
		"created_at":         token.CreatedAt,
		"created_for":        username,
	}
	if registrationURL := s.buildRegistrationURL(plaintext); registrationURL != "" {
		resp["registration_url"] = registrationURL
	}

	writeJSON(w, http.StatusCreated, resp)
}

func (s *Server) handleAdminDeleteRegistration(w http.ResponseWriter, r *http.Request) {
	_, apiErr := s.resolveAdminToken(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	registrationID := r.PathValue("registration_id")
	if registrationID == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "registration_id is required")
		return
	}

	tok, err := s.store.GetRegistrationTokenByID(registrationID)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	if tok == nil {
		writeErrorCode(w, http.StatusNotFound, domain.ErrNotFound, "registration token not found")
		return
	}

	if err := s.store.RevokeRegistrationToken(registrationID); err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
