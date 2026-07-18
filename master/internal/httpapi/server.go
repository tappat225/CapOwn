package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/capown/master/internal/auth"
	"github.com/capown/master/internal/broker"
	"github.com/capown/master/internal/config"
	"github.com/capown/master/internal/domain"
	"github.com/capown/master/internal/events"
	"github.com/capown/master/internal/service"
	"github.com/capown/master/internal/store"
	"github.com/capown/master/internal/tasks"
)

// Server holds all dependencies for the HTTP API.
type Server struct {
	config         *config.Config
	store          *store.Store
	challenges     *auth.ChallengeStore
	workerSessions *auth.SessionStore
	workerBroker   *broker.WorkerBroker
	dashBus        *events.DashboardBus
	mux            *http.ServeMux
	srv            *http.Server
	pwHashSem      chan struct{} // semaphore for password hashing concurrency
	taskStore      *tasks.Store
}

// NewServer creates a new Server with all dependencies.
func NewServer(cfg *config.Config) (*Server, error) {
	// Initialize SQLite store
	st, err := store.New(cfg.Master.DBPath)
	if err != nil {
		return nil, err
	}

	// Initialize in-memory stores
	cs := auth.NewChallengeStore(
		time.Duration(cfg.Master.ChallengeTTL)*time.Second,
		cfg.Master.MaxChallengeStoreSize,
	)
	ss := auth.NewSessionStore(
		time.Duration(cfg.Master.SessionTTL)*time.Second,
		cfg.Master.MaxSessionStoreSize,
	)
	wb := broker.NewWorkerBroker(cfg.Master.MaxWorkerEventQueues, 64)
	db := events.NewDashboardBus(64, cfg.Master.MaxDashboardSubscribers)
	ts := tasks.NewStore()

	s := &Server{
		config:         cfg,
		store:          st,
		challenges:     cs,
		workerSessions: ss,
		workerBroker:   wb,
		dashBus:        db,
		mux:            http.NewServeMux(),
		pwHashSem:      make(chan struct{}, cfg.Master.PasswordHashConcurrency),
		taskStore:      ts,
	}

	s.registerRoutes()
	return s, nil
}

// Handler returns the middleware-wrapped HTTP handler.
func (s *Server) Handler() http.Handler {
	var h http.Handler = s.mux
	h = RequestLogger(h)
	h = Recovery(h)
	h = BodySizeLimit(s.config.Master.MaxBodyBytes)(h)
	h = CORSMiddleware(s.config.Master.AllowedDashboardOrigins)(h)
	h = RateLimiter(s.config.Master.RateLimit)(h)
	return h
}

// Start begins the HTTP server and background jobs, blocks until ctx is cancelled.
func (s *Server) Start(ctx context.Context) error {
	// Start background cleanup jobs
	go service.RunWorkerSweeper(ctx, s.store, s.workerBroker, s.dashBus, s.config.Master.HeartbeatTimeout)
	go service.RunChallengeCleaner(ctx, s.challenges, 60*time.Second)
	go service.RunSessionCleaner(ctx, s.workerSessions, 60*time.Second)
	go service.RunExpiredSessionCleaner(ctx, s.store, 5*time.Minute)
	go service.RunRegistrationTokenCleaner(ctx, s.store, 5*time.Minute)

	s.srv = &http.Server{
		Addr:         s.config.Master.Addr(),
		Handler:      s.Handler(),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 0, // 0 = no timeout — required for SSE long-lived connections
		IdleTimeout:  60 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("listening", "addr", s.config.Master.Addr())
		if err := s.srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()

	select {
	case <-ctx.Done():
		// Graceful shutdown
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return s.srv.Shutdown(shutdownCtx)
	case err := <-errCh:
		return err
	}
}

// Shutdown gracefully stops the server.
func (s *Server) Shutdown(ctx context.Context) error {
	return s.srv.Shutdown(ctx)
}

// registerRoutes sets up all HTTP routes.
func (s *Server) registerRoutes() {
	s.mux.HandleFunc("GET /v1/meta", s.handleMeta)
	s.mux.HandleFunc("GET /v1/health", s.handleHealth)
	s.mux.HandleFunc("GET /healthz", s.handleHealth)

	// Auth routes
	s.mux.HandleFunc("POST /v1/auth/register", s.handleRegister)
	s.mux.HandleFunc("POST /v1/auth/login", s.handleLogin)
	s.mux.HandleFunc("POST /v1/auth/logout", s.handleLogout)
	s.mux.HandleFunc("GET /v1/me", s.handleMe)
	s.mux.HandleFunc("PATCH /v1/me/password", s.handleChangePassword)

	// Token routes
	s.mux.HandleFunc("GET /v1/tokens", s.handleListTokens)
	s.mux.HandleFunc("POST /v1/tokens", s.handleCreateToken)
	s.mux.HandleFunc("DELETE /v1/tokens/{token_id}", s.handleDeleteToken)

	// Worker registration token routes
	s.mux.HandleFunc("GET /v1/worker-registrations", s.handleListRegistrations)
	s.mux.HandleFunc("POST /v1/worker-registrations", s.handleCreateRegistration)
	s.mux.HandleFunc("DELETE /v1/worker-registrations/{registration_id}", s.handleDeleteRegistration)

	// Worker auth routes
	s.mux.HandleFunc("POST /v1/workers", s.handleRegisterWorker)
	s.mux.HandleFunc("POST /v1/workers/auth/challenges", s.handleAuthChallenge)
	s.mux.HandleFunc("POST /v1/workers/auth/sessions", s.handleAuthSession)

	// Worker management routes
	s.mux.HandleFunc("PUT /v1/workers/{worker_id}/runtime", s.handleUpdateRuntime)
	s.mux.HandleFunc("GET /v1/workers/{worker_id}/events", s.handleWorkerEvents)
	s.mux.HandleFunc("GET /v1/workers/{worker_id}", s.handleGetWorker)
	s.mux.HandleFunc("PATCH /v1/workers/{worker_id}", s.handlePatchWorker)
	s.mux.HandleFunc("DELETE /v1/workers/{worker_id}", s.handleDeleteWorker)
	s.mux.HandleFunc("GET /v1/workers", s.handleListWorkers)

	// Plugin routes
	s.mux.HandleFunc("GET /v1/workers/{worker_id}/plugins", s.handleListWorkerPlugins)

	// Task routes
	s.mux.HandleFunc("POST /v1/tasks", s.handleDispatchTask)
	s.mux.HandleFunc("GET /v1/tasks/{task_id}", s.handleGetTask)
	s.mux.HandleFunc("PUT /v1/tasks/{task_id}/result", s.handleReportTaskResult)
	s.mux.HandleFunc("POST /v1/tasks/{task_id}/cancel", s.handleCancelTask)

	// Dashboard events
	s.mux.HandleFunc("GET /v1/events", s.handleDashboardEvents)

	// Admin routes
	s.mux.HandleFunc("GET /v1/admin/users", s.handleAdminListUsers)
	s.mux.HandleFunc("POST /v1/admin/users", s.handleAdminCreateUser)
	s.mux.HandleFunc("GET /v1/admin/users/{username}", s.handleAdminGetUser)
	s.mux.HandleFunc("PATCH /v1/admin/users/{username}", s.handleAdminPatchUser)
	s.mux.HandleFunc("GET /v1/admin/users/{username}/tokens", s.handleAdminListUserTokens)
	s.mux.HandleFunc("POST /v1/admin/users/{username}/tokens", s.handleAdminCreateUserToken)
	s.mux.HandleFunc("DELETE /v1/admin/tokens/{token_id}", s.handleAdminDeleteToken)
	s.mux.HandleFunc("GET /v1/admin/users/{username}/worker-registrations", s.handleAdminListRegistrations)
	s.mux.HandleFunc("POST /v1/admin/users/{username}/worker-registrations", s.handleAdminCreateRegistration)
	s.mux.HandleFunc("DELETE /v1/admin/worker-registrations/{registration_id}", s.handleAdminDeleteRegistration)
}

// --- JSON helpers ---

type MetaResponse struct {
	Product         string   `json:"product"`
	Version         string   `json:"version"`
	ProtocolVersion string   `json:"protocol_version"`
	Initialized     bool     `json:"initialized"`
	Capabilities    []string `json:"capabilities"`
}

func (s *Server) handleMeta(w http.ResponseWriter, r *http.Request) {
	initialized := s.store.CountUsers() > 0
	writeJSON(w, http.StatusOK, MetaResponse{
		Product:         "capown-master",
		Version:         "0.1.0",
		ProtocolVersion: "1.1",
		Initialized:     initialized,
		Capabilities:    []string{},
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// acquirePWHash acquires the password hashing semaphore.
// Callers must call releasePWHash() after the hash operation completes.
func (s *Server) acquirePWHash() {
	s.pwHashSem <- struct{}{}
}

// releasePWHash releases the password hashing semaphore.
func (s *Server) releasePWHash() {
	<-s.pwHashSem
}

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		slog.Error("json encode error", "error", err)
	}
}

func writeError(w http.ResponseWriter, apiErr *domain.APIError) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(apiErr.Status)
	json.NewEncoder(w).Encode(domain.ErrorResponse{Error: *apiErr})
}

func writeErrorCode(w http.ResponseWriter, status int, code, message string) {
	writeError(w, domain.NewAPIError(code, message, status))
}
