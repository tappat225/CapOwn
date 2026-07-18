package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/capown/master/internal/domain"
)

// AuthContext is the resolved identity for an authenticated request.
type AuthContext struct {
	TokenType string // "client", "admin", "web", "worker"
	TokenID   string
	UserID    string
	Username  string
	Role      string // "user" or "admin"
	WorkerID  string // set for worker session tokens
}

func (ctx *AuthContext) hasAdminScope() bool {
	return ctx != nil && ctx.Role == "admin" && (ctx.TokenType == "web" || ctx.TokenType == "admin")
}

// getBearerToken extracts the Bearer token from the Authorization header.
func getBearerToken(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return ""
	}
	return strings.TrimSpace(auth[7:])
}

// resolveWebSession validates a cown_web_* session token.
func (s *Server) resolveWebSession(r *http.Request) (*AuthContext, *domain.APIError) {
	token := getBearerToken(r)
	if token == "" {
		return nil, domain.NewAPIError(domain.ErrUnauthorized, "missing authorization header", http.StatusUnauthorized)
	}
	if !strings.HasPrefix(token, "cown_web_") {
		return nil, domain.NewAPIError(domain.ErrUnauthorized, "invalid session token", http.StatusUnauthorized)
	}

	sess, err := s.store.ValidateSession(token)
	if err != nil {
		return nil, domain.NewAPIError(domain.ErrInternal, "internal error", http.StatusInternalServerError)
	}
	if sess == nil {
		return nil, domain.NewAPIError(domain.ErrUnauthorized, "invalid or expired session", http.StatusUnauthorized)
	}

	user, err := s.store.GetUserByID(sess.UserID)
	if err != nil {
		return nil, domain.NewAPIError(domain.ErrInternal, "internal error", http.StatusInternalServerError)
	}
	if user == nil {
		return nil, domain.NewAPIError(domain.ErrUnauthorized, "user not found", http.StatusUnauthorized)
	}
	if user.Status == "disabled" {
		return nil, domain.NewAPIError(domain.ErrForbidden, "user is disabled", http.StatusForbidden)
	}
	return &AuthContext{
		TokenType: "web",
		TokenID:   sess.SessionID,
		UserID:    user.UserID,
		Username:  user.Username,
		Role:      user.Role,
	}, nil
}

// resolveAdminToken validates an admin bearer token.
func (s *Server) resolveAdminToken(r *http.Request) (*AuthContext, *domain.APIError) {
	token := getBearerToken(r)
	if token == "" {
		return nil, domain.NewAPIError(domain.ErrUnauthorized, "missing authorization header", http.StatusUnauthorized)
	}

	// Check web sessions with admin role first
	if strings.HasPrefix(token, "cown_web_") {
		ctx, err := s.resolveWebSession(r)
		if err != nil {
			return nil, err
		}
		if ctx.Role != "admin" {
			return nil, domain.NewAPIError(domain.ErrForbidden, "admin access required", http.StatusForbidden)
		}
		return ctx, nil
	}

	// Check auth_tokens for admin token
	tok, err := s.store.ValidateToken(token)
	if err != nil {
		return nil, domain.NewAPIError(domain.ErrInternal, "internal error", http.StatusInternalServerError)
	}
	if tok == nil {
		return nil, domain.NewAPIError(domain.ErrUnauthorized, "invalid token", http.StatusUnauthorized)
	}
	if tok.TokenType != "admin" {
		return nil, domain.NewAPIError(domain.ErrForbidden, "admin access required", http.StatusForbidden)
	}

	user, err := s.store.GetUserByID(tok.UserID)
	if err != nil || user == nil {
		return nil, domain.NewAPIError(domain.ErrForbidden, "user not found", http.StatusForbidden)
	}
	if user.Status == "disabled" {
		return nil, domain.NewAPIError(domain.ErrForbidden, "user is disabled", http.StatusForbidden)
	}
	if user.Role != "admin" {
		return nil, domain.NewAPIError(domain.ErrForbidden, "admin role required", http.StatusForbidden)
	}

	return &AuthContext{
		TokenType: "admin",
		TokenID:   tok.TokenID,
		UserID:    user.UserID,
		Username:  user.Username,
		Role:      user.Role,
	}, nil
}

// resolveWorkerSession validates a cown_sess_* worker session token.
func (s *Server) resolveWorkerSession(r *http.Request, workerID string) (*AuthContext, *domain.APIError) {
	token := getBearerToken(r)
	if token == "" {
		return nil, domain.NewAPIError(domain.ErrUnauthorized, "missing authorization header", http.StatusUnauthorized)
	}
	if !strings.HasPrefix(token, "cown_sess_") {
		return nil, domain.NewAPIError(domain.ErrUnauthorized, "invalid worker session token", http.StatusUnauthorized)
	}

	entry := s.workerSessions.Validate(token)
	if entry == nil {
		return nil, domain.NewAPIError(domain.ErrUnauthorized, "invalid or expired worker session", http.StatusUnauthorized)
	}
	if entry.WorkerID != workerID {
		return nil, domain.NewAPIError(domain.ErrForbidden, "session does not match worker", http.StatusForbidden)
	}

	return &AuthContext{
		TokenType: "worker",
		UserID:    entry.UserID,
		Username:  entry.Username,
		WorkerID:  entry.WorkerID,
		Role:      "user",
	}, nil
}

// resolveClientAPI accepts web, client, and admin tokens. Rejects worker sessions.
func (s *Server) resolveClientAPI(r *http.Request) (*AuthContext, *domain.APIError) {
	token := getBearerToken(r)
	if token == "" {
		return nil, domain.NewAPIError(domain.ErrUnauthorized, "missing authorization header", http.StatusUnauthorized)
	}

	if strings.HasPrefix(token, "cown_sess_") {
		return nil, domain.NewAPIError(domain.ErrForbidden, "worker sessions cannot access this endpoint", http.StatusForbidden)
	}

	if strings.HasPrefix(token, "cown_web_") {
		return s.resolveWebSession(r)
	}

	tok, err := s.store.ValidateToken(token)
	if err != nil {
		return nil, domain.NewAPIError(domain.ErrInternal, "internal error", http.StatusInternalServerError)
	}
	if tok == nil {
		return nil, domain.NewAPIError(domain.ErrUnauthorized, "invalid token", http.StatusUnauthorized)
	}
	if tok.TokenType != "client" && tok.TokenType != "admin" {
		return nil, domain.NewAPIError(domain.ErrForbidden, "token type cannot access this endpoint", http.StatusForbidden)
	}

	user, err := s.store.GetUserByID(tok.UserID)
	if err != nil || user == nil {
		return nil, domain.NewAPIError(domain.ErrForbidden, "user not found", http.StatusForbidden)
	}
	if user.Status == "disabled" {
		return nil, domain.NewAPIError(domain.ErrForbidden, "user is disabled", http.StatusForbidden)
	}

	return &AuthContext{
		TokenType: tok.TokenType,
		TokenID:   tok.TokenID,
		UserID:    user.UserID,
		Username:  user.Username,
		Role:      user.Role,
	}, nil
}

// resolveAPI accepts any valid token type for general API access.
func (s *Server) resolveAPI(r *http.Request) (*AuthContext, *domain.APIError) {
	token := getBearerToken(r)
	if token == "" {
		return nil, domain.NewAPIError(domain.ErrUnauthorized, "missing authorization header", http.StatusUnauthorized)
	}

	// Worker session
	if strings.HasPrefix(token, "cown_sess_") {
		entry := s.workerSessions.Validate(token)
		if entry == nil {
			return nil, domain.NewAPIError(domain.ErrUnauthorized, "invalid or expired worker session", http.StatusUnauthorized)
		}
		return &AuthContext{
			TokenType: "worker",
			UserID:    entry.UserID,
			Username:  entry.Username,
			WorkerID:  entry.WorkerID,
			Role:      "user",
		}, nil
	}

	// Web session
	if strings.HasPrefix(token, "cown_web_") {
		return s.resolveWebSession(r)
	}

	// Client/admin token
	tok, err := s.store.ValidateToken(token)
	if err != nil {
		return nil, domain.NewAPIError(domain.ErrInternal, "internal error", http.StatusInternalServerError)
	}
	if tok == nil {
		return nil, domain.NewAPIError(domain.ErrUnauthorized, "invalid token", http.StatusUnauthorized)
	}

	user, err := s.store.GetUserByID(tok.UserID)
	if err != nil || user == nil {
		return nil, domain.NewAPIError(domain.ErrForbidden, "user not found", http.StatusForbidden)
	}
	if user.Status == "disabled" {
		return nil, domain.NewAPIError(domain.ErrForbidden, "user is disabled", http.StatusForbidden)
	}

	return &AuthContext{
		TokenType: tok.TokenType,
		TokenID:   tok.TokenID,
		UserID:    user.UserID,
		Username:  user.Username,
		Role:      user.Role,
	}, nil
}

// --- Request body helpers ---

func decodeJSON(r *http.Request, v interface{}) *domain.APIError {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(v); err != nil {
		return domain.NewAPIError(domain.ErrInvalidInput, "invalid JSON body: "+err.Error(), http.StatusBadRequest)
	}
	return nil
}
