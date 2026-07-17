package auth

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

// SessionEntry holds a worker session token.
type SessionEntry struct {
	WorkerID  string
	UserID    string
	Username  string
	ExpiresAt time.Time
}

// SessionStore is an in-memory store for worker session tokens (cown_sess_*).
type SessionStore struct {
	mu    sync.RWMutex
	store map[string]*SessionEntry
	ttl   time.Duration
	max   int
}

// NewSessionStore creates a new SessionStore.
func NewSessionStore(ttl time.Duration, max int) *SessionStore {
	return &SessionStore{
		store: make(map[string]*SessionEntry),
		ttl:   ttl,
		max:   max,
	}
}

// Create generates a new cown_sess_* token for the given worker/user.
func (ss *SessionStore) Create(workerID, userID, username string) (sessionToken string) {
	ss.mu.Lock()
	defer ss.mu.Unlock()

	// Evict oldest if at capacity
	if len(ss.store) >= ss.max {
		var oldestKey string
		var oldestTime time.Time
		for k, v := range ss.store {
			if oldestKey == "" || v.ExpiresAt.Before(oldestTime) {
				oldestKey = k
				oldestTime = v.ExpiresAt
			}
		}
		delete(ss.store, oldestKey)
	}

	b := make([]byte, 20)
	rand.Read(b)
	sessionToken = "cown_sess_" + hex.EncodeToString(b)
	exp := time.Now().UTC().Add(ss.ttl)

	ss.store[sessionToken] = &SessionEntry{
		WorkerID:  workerID,
		UserID:    userID,
		Username:  username,
		ExpiresAt: exp,
	}
	return sessionToken
}

// Validate looks up a session token and returns the entry if valid.
func (ss *SessionStore) Validate(sessionToken string) *SessionEntry {
	ss.mu.RLock()
	entry, ok := ss.store[sessionToken]
	ss.mu.RUnlock()

	if !ok {
		return nil
	}
	if time.Now().UTC().After(entry.ExpiresAt) {
		ss.mu.Lock()
		delete(ss.store, sessionToken)
		ss.mu.Unlock()
		return nil
	}
	return entry
}

// Revoke removes a session token.
func (ss *SessionStore) Revoke(sessionToken string) bool {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	_, ok := ss.store[sessionToken]
	delete(ss.store, sessionToken)
	return ok
}

// RevokeWorker removes all session tokens for a worker.
func (ss *SessionStore) RevokeWorker(workerID string) int {
	ss.mu.Lock()
	defer ss.mu.Unlock()

	count := 0
	for k, v := range ss.store {
		if v.WorkerID == workerID {
			delete(ss.store, k)
			count++
		}
	}
	return count
}

// RevokeUser removes all session tokens for workers owned by a user.
func (ss *SessionStore) RevokeUser(userID string) int {
	ss.mu.Lock()
	defer ss.mu.Unlock()

	count := 0
	for k, v := range ss.store {
		if v.UserID == userID {
			delete(ss.store, k)
			count++
		}
	}
	return count
}

// Cleanup removes expired sessions.
func (ss *SessionStore) Cleanup() int {
	ss.mu.Lock()
	defer ss.mu.Unlock()

	now := time.Now().UTC()
	count := 0
	for k, v := range ss.store {
		if now.After(v.ExpiresAt) {
			delete(ss.store, k)
			count++
		}
	}
	return count
}
