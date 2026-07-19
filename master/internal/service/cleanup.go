package service

import (
	"context"
	"log/slog"
	"time"

	"github.com/capown/master/internal/auth"
	"github.com/capown/master/internal/broker"
	"github.com/capown/master/internal/events"
	"github.com/capown/master/internal/store"
	"github.com/capown/master/internal/tasks"
)

// RunWorkerSweeper marks stale workers offline.
func RunWorkerSweeper(ctx context.Context, s *store.Store, b *broker.WorkerBroker, db *events.DashboardBus, ts *tasks.Store, timeoutSeconds int) {
	interval := time.Duration(timeoutSeconds/2) * time.Second
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			stale, err := s.SweepStale(timeoutSeconds)
			if err != nil {
				slog.Warn("worker sweep error", "error", err)
				continue
			}
			for _, workerID := range stale {
				// A long-poll keeps the Worker alive even though it cannot update
				// its heartbeat until the request returns.
				if ts != nil && ts.HasPoller(workerID) {
					continue
				}
				slog.Warn("worker stale, marking offline", "worker_id", workerID)
				if ts != nil {
					if recovered := ts.RecoverWorker(workerID); recovered > 0 {
						slog.Warn("recovered tasks from stale worker", "worker_id", workerID, "count", recovered)
					}
				}
				s.MarkOffline(workerID)
				b.DrainAndClose(workerID)
				db.PublishByWorker(workerID, "worker.offline",
					map[string]string{"worker_id": workerID},
					func(wid string) (string, error) {
						owner, err := s.GetOwner(wid)
						if err != nil || owner == nil {
							return "", err
						}
						return owner.UserID, nil
					})
			}
		}
	}
}

// RunChallengeCleaner removes expired nonces.
func RunChallengeCleaner(ctx context.Context, cs *auth.ChallengeStore, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			count := cs.Cleanup()
			if count > 0 {
				slog.Debug("cleaned expired challenges", "count", count)
			}
		}
	}
}

// RunSessionCleaner removes expired in-memory worker sessions.
func RunSessionCleaner(ctx context.Context, ss *auth.SessionStore, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			count := ss.Cleanup()
			if count > 0 {
				slog.Debug("cleaned expired worker sessions", "count", count)
			}
		}
	}
}

// RunExpiredSessionCleaner removes expired web sessions from the DB.
func RunExpiredSessionCleaner(ctx context.Context, s *store.Store, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			count, err := s.CleanExpiredSessions()
			if err != nil {
				slog.Warn("clean expired sessions error", "error", err)
			} else if count > 0 {
				slog.Debug("cleaned expired web sessions", "count", count)
			}
		}
	}
}

// RunRegistrationTokenCleaner removes expired registration tokens.
func RunRegistrationTokenCleaner(ctx context.Context, s *store.Store, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			count, err := s.CleanExpiredRegistrationTokens()
			if err != nil {
				slog.Warn("clean expired registrations error", "error", err)
			} else if count > 0 {
				slog.Debug("cleaned expired registration tokens", "count", count)
			}
		}
	}
}
