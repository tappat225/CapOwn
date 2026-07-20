package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/capown/master/internal/domain"
	"github.com/capown/master/internal/store"
)

// --- Auth Handlers ---

type registerRequest struct {
	Username       string `json:"username"`
	Password       string `json:"password"`
	InvitationCode string `json:"invitation_code"`
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type loginResponse struct {
	AccessToken string                 `json:"access_token"`
	TokenType   string                 `json:"token_type"`
	ExpiresAt   string                 `json:"expires_at"`
	User        map[string]interface{} `json:"user"`
}

type changePasswordRequest struct {
	OldPassword string `json:"old_password"`
	NewPassword string `json:"new_password"`
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req registerRequest
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

	var userID, sessionToken, expiresAt string
	var err error
	if s.store.CountUsers() == 0 {
		userID, sessionToken, expiresAt, err = s.store.RegisterFirstUser(
			req.Username, req.Password, s.config.Master.SessionTTL,
		)
	} else {
		if req.InvitationCode == "" {
			writeErrorCode(w, http.StatusBadRequest, domain.ErrInvitationInvalid, "invitation code is required")
			return
		}
		userID, sessionToken, expiresAt, err = s.store.RegisterInvitedUser(
			req.InvitationCode, req.Username, req.Password, s.config.Master.SessionTTL,
		)
	}
	if err != nil {
		if errors.Is(err, store.ErrInvitationInvalid) {
			writeErrorCode(w, http.StatusBadRequest, domain.ErrInvitationInvalid, "invitation code is invalid or expired")
			return
		}
		if errors.Is(err, store.ErrUsernameConflict) {
			writeErrorCode(w, http.StatusConflict, domain.ErrConflict, "username already taken")
			return
		}
		if err.Error() == "registration closed" {
			writeError(w, domain.ErrRegistrationClosedResp)
			return
		}
		writeErrorCode(w, http.StatusConflict, domain.ErrConflict, "username already taken or registration failed")
		return
	}

	user, _ := s.store.GetUserByID(userID)
	resp := loginResponse{
		AccessToken: sessionToken,
		TokenType:   "bearer",
		ExpiresAt:   expiresAt,
		User:        store.UserToDomain(user),
	}

	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, resp)
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}

	if req.Username == "" || req.Password == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "username and password are required")
		return
	}

	user, err := s.store.GetUser(req.Username)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}
	if user == nil {
		writeErrorCode(w, http.StatusUnauthorized, domain.ErrUnauthorized, "invalid credentials")
		return
	}
	if user.Status != "active" {
		writeErrorCode(w, http.StatusForbidden, domain.ErrUserDisabled, "user is disabled")
		return
	}

	// Verify password (under concurrency semaphore to limit PBKDF2 CPU usage)
	s.acquirePWHash()
	match := store.VerifyPassword(req.Password, user.PasswordHash, user.PasswordSalt)
	s.releasePWHash()

	if !match {
		writeErrorCode(w, http.StatusUnauthorized, domain.ErrUnauthorized, "invalid credentials")
		return
	}

	// Create web session
	sessionToken, _, expiresAt, err := s.store.CreateSessionToken(user.UserID, s.config.Master.SessionTTL)
	if err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}

	resp := loginResponse{
		AccessToken: sessionToken,
		TokenType:   "bearer",
		ExpiresAt:   expiresAt,
		User:        store.UserToDomain(user),
	}

	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	token := getBearerToken(r)
	if token == "" || !strings.HasPrefix(token, "cown_web_") {
		writeErrorCode(w, http.StatusUnauthorized, domain.ErrUnauthorized, "unauthorized")
		return
	}

	if err := s.store.RevokeSession(token); err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "logged_out"})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	ctx, apiErr := s.resolveWebSession(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	user, err := s.store.GetUserByID(ctx.UserID)
	if err != nil || user == nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}

	writeJSON(w, http.StatusOK, store.UserToDomain(user))
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	ctx, apiErr := s.resolveWebSession(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	var req changePasswordRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}

	if req.NewPassword == "" {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "new password is required")
		return
	}
	if !hasMinimumPasswordLength(req.NewPassword) {
		writeErrorCode(w, http.StatusBadRequest, domain.ErrInvalidInput, "new password must be at least 6 characters")
		return
	}

	// Verify old password
	user, err := s.store.GetUserByID(ctx.UserID)
	if err != nil || user == nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}

	if !store.VerifyPassword(req.OldPassword, user.PasswordHash, user.PasswordSalt) {
		writeErrorCode(w, http.StatusUnauthorized, domain.ErrUnauthorized, "invalid password")
		return
	}

	// Set new password
	if err := s.store.SetPassword(ctx.UserID, req.NewPassword); err != nil {
		writeError(w, domain.ErrInternalResponse)
		return
	}

	// Revoke all other sessions (not the current one)
	token := getBearerToken(r)
	currentHash := store.HashToken(token)

	// Get all sessions and revoke all except current
	sessions, err := s.store.ListUserSessions(ctx.UserID)
	if err != nil {
		slog.Warn("failed to list sessions after password change", "error", err)
	}
	revoked := 0
	for _, sess := range sessions {
		if sess.TokenHash != currentHash {
			if err := s.store.RevokeSessionByID(sess.SessionID); err == nil {
				revoked++
			}
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":           "password_updated",
		"sessions_revoked": revoked,
	})
}
