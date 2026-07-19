package httpapi

import (
	"net/http"
	"time"

	"github.com/capown/master/internal/events"
)

func (s *Server) handleDashboardEvents(w http.ResponseWriter, r *http.Request) {
	ctx, apiErr := s.resolveWebSession(r)
	if apiErr != nil {
		writeError(w, apiErr)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErrorCode(w, http.StatusInternalServerError, "internal_error", "streaming not supported")
		return
	}

	// Get last event ID from header
	lastEventID := r.Header.Get("Last-Event-ID")

	scope := ctx.UserID
	if ctx.Role == "admin" {
		scope = events.AdminGlobalScope
	}
	ch := s.dashBus.Subscribe(scope, lastEventID)
	defer s.dashBus.Unsubscribe(scope, ch)

	notify := r.Context().Done()
	pingTicker := time.NewTicker(20 * time.Second)
	defer pingTicker.Stop()
	authTicker := time.NewTicker(5 * time.Second)
	defer authTicker.Stop()

	for {
		select {
		case <-notify:
			return

		case <-pingTicker.C:
			if _, err := w.Write([]byte(": ping\n\n")); err != nil {
				return
			}
			flusher.Flush()

		case <-authTicker.C:
			user, err := s.store.GetUserByID(ctx.UserID)
			if err != nil || user == nil || user.Status != "active" {
				return
			}

		case evt, ok := <-ch:
			if !ok {
				return
			}
			data := events.MarshalDashboardEvent(evt)
			if _, err := w.Write([]byte(data)); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
