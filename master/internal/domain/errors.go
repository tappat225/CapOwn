package domain

import "net/http"

// APIError represents a structured API error response.
type APIError struct {
	Code    string      `json:"code"`
	Message string      `json:"message"`
	Details interface{} `json:"details"`
	Status  int         `json:"-"`
}

func (e *APIError) Error() string {
	return e.Code + ": " + e.Message
}

// Error codes
const (
	ErrUnauthorized          = "unauthorized"
	ErrForbidden             = "forbidden"
	ErrInvalidInput          = "invalid_input"
	ErrConflict              = "conflict"
	ErrInternal              = "internal_error"
	ErrNotFound              = "not_found"
	ErrMethodNotAllowed      = "method_not_allowed"
	ErrRegistrationClosed    = "registration_closed"
	ErrUserNotFound          = "user_not_found"
	ErrTokenNotFound         = "token_not_found"
	ErrWorkerNotFound        = "worker_not_found"
	ErrWorkerNameInvalid     = "worker_name_invalid"
	ErrSignatureInvalid      = "signature_invalid"
	ErrRegistrationInvalid   = "registration_invalid"
	ErrRegistrationExpired   = "registration_expired"
	ErrRegistrationExhausted = "registration_exhausted"
	ErrRateLimited           = "rate_limited"
	ErrUserDisabled          = "user_disabled"
)

// NewAPIError creates a new APIError with the given code, message, and HTTP status.
func NewAPIError(code string, message string, status int) *APIError {
	return &APIError{Code: code, Message: message, Status: status}
}

// ErrorResponse is the outer error envelope.
type ErrorResponse struct {
	Error APIError `json:"error"`
}

// Common API errors
var (
	ErrUnauthorizedResponse     = NewAPIError(ErrUnauthorized, "unauthorized", http.StatusUnauthorized)
	ErrForbiddenResponse        = NewAPIError(ErrForbidden, "forbidden", http.StatusForbidden)
	ErrRegistrationClosedResp   = NewAPIError(ErrRegistrationClosed, "registration is closed", http.StatusConflict)
	ErrInternalResponse         = NewAPIError(ErrInternal, "internal server error", http.StatusInternalServerError)
	ErrNotFoundResponse         = NewAPIError(ErrNotFound, "not found", http.StatusNotFound)
	ErrMethodNotAllowedResponse = NewAPIError(ErrMethodNotAllowed, "method not allowed", http.StatusMethodNotAllowed)
	ErrRateLimitedResponse      = NewAPIError(ErrRateLimited, "too many requests", http.StatusTooManyRequests)
)
