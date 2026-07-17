package httpapi

import (
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/capown/master/internal/domain"
)

// RequestLogger logs every request.
func RequestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		lw := &loggingResponseWriter{ResponseWriter: w, statusCode: http.StatusOK}
		next.ServeHTTP(lw, r)
		slog.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", lw.statusCode,
			"duration", time.Since(start).String(),
		)
	})
}

type loggingResponseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (lw *loggingResponseWriter) WriteHeader(code int) {
	lw.statusCode = code
	lw.ResponseWriter.WriteHeader(code)
}

// Flush implements http.Flusher so SSE works through the logging middleware.
func (lw *loggingResponseWriter) Flush() {
	if f, ok := lw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Recovery recovers from panics and returns a 500 error.
func Recovery(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				slog.Error("panic recovered", "path", r.URL.Path, "panic", rec)
				writeError(w, domain.ErrInternalResponse)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// BodySizeLimit limits the size of request bodies.
func BodySizeLimit(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			next.ServeHTTP(w, r)
		})
	}
}

// CORSMiddleware handles CORS with exact origin matching when configured.
// An empty allowlist permits browser access from any origin.
func CORSMiddleware(allowedOrigins []string) func(http.Handler) http.Handler {
	originSet := make(map[string]bool, len(allowedOrigins))
	for _, o := range allowedOrigins {
		originSet[o] = true
	}
	unrestricted := len(allowedOrigins) == 0

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")

			if origin != "" && (unrestricted || originSet[origin]) {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")

				if r.Method == http.MethodOptions {
					w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
					w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Last-Event-ID")
					w.Header().Set("Access-Control-Max-Age", "86400")
					w.WriteHeader(http.StatusNoContent)
					return
				}
			}

			next.ServeHTTP(w, r)
		})
	}
}

// RateLimiter implements a simple per-IP token bucket rate limiter.
// Only applies to login and register endpoints.
func RateLimiter(requestsPerMinute int) func(http.Handler) http.Handler {
	if requestsPerMinute <= 0 {
		requestsPerMinute = 10
	}

	type bucket struct {
		tokens    float64
		lastCheck time.Time
	}

	var mu sync.Mutex
	buckets := make(map[string]*bucket)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Only rate limit login and register
			path := r.URL.Path
			if path != "/v1/auth/login" && path != "/v1/auth/register" {
				next.ServeHTTP(w, r)
				return
			}

			// Strip port from RemoteAddr for consistent per-IP limiting
			ip := r.RemoteAddr
			if idx := strings.LastIndex(ip, ":"); idx > 0 {
				// IPv4 with port
				ip = ip[:idx]
			} else if idx := strings.LastIndex(ip, "]:"); idx > 0 {
				// IPv6 with port
				ip = ip[1:idx]
			}
			mu.Lock()
			b, ok := buckets[ip]
			if !ok {
				b = &bucket{tokens: float64(requestsPerMinute), lastCheck: time.Now()}
				buckets[ip] = b
			}

			// Refill tokens
			now := time.Now()
			elapsed := now.Sub(b.lastCheck).Seconds()
			b.tokens += elapsed * (float64(requestsPerMinute) / 60.0)
			if b.tokens > float64(requestsPerMinute) {
				b.tokens = float64(requestsPerMinute)
			}
			b.lastCheck = now

			if b.tokens < 1.0 {
				mu.Unlock()
				writeError(w, domain.ErrRateLimitedResponse)
				return
			}
			b.tokens--
			mu.Unlock()

			next.ServeHTTP(w, r)
		})
	}
}
