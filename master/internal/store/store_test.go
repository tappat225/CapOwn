package store

import (
	"errors"
	"os"
	"sync"
	"testing"
	"time"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	f, err := os.CreateTemp("", "master-test-*.db")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	s, err := New(f.Name())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		s.Close()
		os.Remove(f.Name())
	})
	return s
}

func TestHashPasswordVerify(t *testing.T) {
	hash, salt := HashPassword("test-password-123")
	if hash == "" || salt == "" {
		t.Fatal("hash and salt should not be empty")
	}
	if !VerifyPassword("test-password-123", hash, salt) {
		t.Error("VerifyPassword should match")
	}
	if VerifyPassword("wrong-password", hash, salt) {
		t.Error("VerifyPassword should reject wrong password")
	}
}

func TestVerifyPasswordEmpty(t *testing.T) {
	if VerifyPassword("pwd", "", "salt") {
		t.Error("empty stored hash should fail")
	}
	if VerifyPassword("pwd", "hash", "") {
		t.Error("empty salt should fail")
	}
}

func TestHashToken(t *testing.T) {
	h := HashToken("test-token")
	if len(h) != 64 {
		t.Errorf("expected 64-char hash, got %d", len(h))
	}
}

func TestRegisterFirstUser(t *testing.T) {
	s := newTestStore(t)

	userID, sessionToken, expiresAt, err := s.RegisterFirstUser("admin", "password123", 3600)
	if err != nil {
		t.Fatal(err)
	}
	if userID == "" {
		t.Error("userID should not be empty")
	}
	if sessionToken == "" {
		t.Error("sessionToken should not be empty")
	}
	if expiresAt == "" {
		t.Error("expiresAt should not be empty")
	}

	// Second registration should fail
	_, _, _, err = s.RegisterFirstUser("admin2", "password123", 3600)
	if err == nil {
		t.Error("second registration should fail")
	}

	// Verify user was created
	user, err := s.GetUser("admin")
	if err != nil {
		t.Fatal(err)
	}
	if user == nil {
		t.Fatal("user not found")
	}
	if user.Role != "admin" {
		t.Errorf("expected admin role, got %q", user.Role)
	}
	if user.PasswordHash == "" {
		t.Error("password should be set")
	}
}

func TestInvitationRegistrationIsSingleUseAndAtomic(t *testing.T) {
	s := newTestStore(t)
	adminID, _, _, err := s.RegisterFirstUser("admin", "password123", 3600)
	if err != nil {
		t.Fatal(err)
	}
	code, invitation, err := s.CreateInvitation(adminID, "new teammate", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if code == "" || invitation.CodeHash == code || invitation.CodePrefix == "" {
		t.Fatal("invitation secret handling is invalid")
	}

	userID, session, _, err := s.RegisterInvitedUser(code, "alice", "secret1", 3600)
	if err != nil {
		t.Fatal(err)
	}
	if userID == "" || session == "" {
		t.Fatal("invited registration did not create a user session")
	}
	user, err := s.GetUser("alice")
	if err != nil || user == nil || user.Role != "user" {
		t.Fatalf("unexpected invited user: %#v, %v", user, err)
	}
	if _, _, _, err := s.RegisterInvitedUser(code, "bob", "secret1", 3600); !errors.Is(err, ErrInvitationInvalid) {
		t.Fatalf("reused invitation should fail, got %v", err)
	}
}

func TestUsernameConflictDoesNotConsumeInvitation(t *testing.T) {
	s := newTestStore(t)
	adminID, _, _, err := s.RegisterFirstUser("admin", "password123", 3600)
	if err != nil {
		t.Fatal(err)
	}
	code, _, err := s.CreateInvitation(adminID, "", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := s.RegisterInvitedUser(code, "admin", "secret1", 3600); !errors.Is(err, ErrUsernameConflict) {
		t.Fatalf("expected username conflict, got %v", err)
	}
	if _, _, _, err := s.RegisterInvitedUser(code, "alice", "secret1", 3600); err != nil {
		t.Fatalf("invitation should remain usable after a rolled-back conflict: %v", err)
	}
}

func TestExpiredInvitationIsRejected(t *testing.T) {
	s := newTestStore(t)
	adminID, _, _, err := s.RegisterFirstUser("admin", "password123", 3600)
	if err != nil {
		t.Fatal(err)
	}
	code, _, err := s.CreateInvitation(adminID, "", -time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := s.RegisterInvitedUser(code, "alice", "secret1", 3600); !errors.Is(err, ErrInvitationInvalid) {
		t.Fatalf("expired invitation should fail, got %v", err)
	}
}

func TestRegisterFirstUserConcurrent(t *testing.T) {
	s := newTestStore(t)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, username := range []string{"admin-a", "admin-b"} {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			_, _, _, err := s.RegisterFirstUser(name, "password123", 3600)
			results <- err
		}(username)
	}
	wg.Wait()
	close(results)

	successes := 0
	for err := range results {
		if err == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("expected exactly one successful registration, got %d", successes)
	}
	if count := s.CountUsers(); count != 1 {
		t.Fatalf("expected exactly one user, got %d", count)
	}
}

func TestParseTimestampPythonCompatibility(t *testing.T) {
	for _, value := range []string{
		"2026-07-16T12:34:56.123456",
		"2026-07-16T12:34:56Z",
	} {
		if _, err := ParseTimestamp(value); err != nil {
			t.Fatalf("ParseTimestamp(%q): %v", value, err)
		}
	}
}

func TestCreateAndValidateToken(t *testing.T) {
	s := newTestStore(t)

	_, _, _, err := s.RegisterFirstUser("admin", "password123", 3600)
	if err != nil {
		t.Fatal(err)
	}
	user, err := s.GetUser("admin")
	if err != nil {
		t.Fatal(err)
	}

	plaintext, token, err := s.CreateToken(user.UserID, "client", "test-token")
	if err != nil {
		t.Fatal(err)
	}
	if plaintext == "" {
		t.Error("plaintext should not be empty")
	}
	if token.TokenType != "client" {
		t.Errorf("expected client type, got %q", token.TokenType)
	}

	// Validate
	validated, err := s.ValidateToken(plaintext)
	if err != nil {
		t.Fatal(err)
	}
	if validated == nil {
		t.Error("token should be valid")
	}
}

func TestCreateSessionAndValidate(t *testing.T) {
	s := newTestStore(t)

	_, _, _, err := s.RegisterFirstUser("admin", "password123", 3600)
	if err != nil {
		t.Fatal(err)
	}
	user, err := s.GetUser("admin")
	if err != nil {
		t.Fatal(err)
	}

	plaintext, _, _, err := s.CreateSessionToken(user.UserID, 3600)
	if err != nil {
		t.Fatal(err)
	}

	sess, err := s.ValidateSession(plaintext)
	if err != nil {
		t.Fatal(err)
	}
	if sess == nil {
		t.Error("session should be valid")
	}

	// Revoke and check
	if err := s.RevokeSession(plaintext); err != nil {
		t.Fatal(err)
	}
	sess, err = s.ValidateSession(plaintext)
	if err != nil {
		t.Fatal(err)
	}
	if sess != nil {
		t.Error("revoked session should be invalid")
	}
}

func TestRegistrationTokenLifecycle(t *testing.T) {
	s := newTestStore(t)

	_, _, _, err := s.RegisterFirstUser("admin", "password123", 3600)
	if err != nil {
		t.Fatal(err)
	}
	user, err := s.GetUser("admin")
	if err != nil {
		t.Fatal(err)
	}
	plaintext, token, err := s.CreateRegistrationToken(user.UserID, 3600, 1, "test-registration")
	if err != nil {
		t.Fatal(err)
	}

	// Validate
	validated, err := s.ValidateRegistrationToken(plaintext)
	if err != nil {
		t.Fatal(err)
	}
	if validated == nil {
		t.Fatal("registration token should be valid")
	}
	if validated.Label != "test-registration" {
		t.Errorf("expected label 'test-registration', got %q", validated.Label)
	}

	// Consume
	if err := s.ConsumeRegistrationToken(token.TokenID); err != nil {
		t.Fatal(err)
	}

	// After consumption, should be exhausted
	validated, err = s.ValidateRegistrationToken(plaintext)
	if err != nil {
		t.Fatal(err)
	}
	if validated != nil {
		t.Error("exhausted registration token should be invalid")
	}
}

func TestRenameAndRevokeWorkerAtomic(t *testing.T) {
	s := newTestStore(t)
	_, _, _, err := s.RegisterFirstUser("admin", "password123", 3600)
	if err != nil {
		t.Fatal(err)
	}
	user, _ := s.GetUser("admin")
	plaintext, _, err := s.CreateRegistrationToken(user.UserID, 3600, 1, "worker")
	if err != nil {
		t.Fatal(err)
	}
	workerID, _, err := s.RegisterWorkerAtomic(
		plaintext, "worker_one", "host", "00", "linux", "capability", "", "",
	)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := s.GetActiveWorker(workerID)
	if err != nil || worker == nil || worker.Status != "offline" || worker.LastHeartbeat.Valid {
		t.Fatalf("new Worker should be offline before runtime heartbeat: %#v, %v", worker, err)
	}
	if _, becameOnline, err := s.ReconnectWorker(workerID, "host", "linux", "capability", "", "", "[]"); err != nil || !becameOnline {
		t.Fatalf("runtime heartbeat should bring Worker online: became_online=%v err=%v", becameOnline, err)
	}
	if err := s.RenameWorkerAtomic(workerID, user.UserID, "worker.two"); err != nil {
		t.Fatal(err)
	}
	worker, err = s.GetActiveWorker(workerID)
	if err != nil || worker == nil {
		t.Fatalf("get renamed worker: %v", err)
	}
	if worker.WorkerName != "worker.two" || !worker.PreviousWorkerName.Valid || worker.PreviousWorkerName.String != "worker_one" {
		t.Fatalf("unexpected rename state: %#v", worker)
	}
	owner, err := s.GetOwner(workerID)
	if err != nil || owner == nil || owner.WorkerName != "worker.two" {
		t.Fatalf("owner binding was not renamed: %#v, %v", owner, err)
	}
	if err := s.RevokeWorkerAtomic(workerID, "wrong-owner"); err != ErrWorkerNotFound {
		t.Fatalf("wrong owner should not revoke worker, got %v", err)
	}
	if err := s.RevokeWorkerAtomic(workerID, user.UserID); err != nil {
		t.Fatal(err)
	}
	if active, err := s.GetActiveWorker(workerID); err != nil || active != nil {
		t.Fatalf("revoked worker should be inactive: %#v, %v", active, err)
	}
}
