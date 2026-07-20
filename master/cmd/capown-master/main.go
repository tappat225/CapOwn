package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/capown/master/internal/config"
	"github.com/capown/master/internal/httpapi"
	"github.com/capown/master/internal/version"
)

func main() {
	// Determine config path
	configPath := os.Getenv("CAPOWN_MASTER_CONFIG")
	cfg := config.Load(configPath)

	// Set up structured logger
	logLevel := new(slog.LevelVar)
	switch cfg.Master.LogLevel {
	case "debug":
		logLevel.Set(slog.LevelDebug)
	case "info":
		logLevel.Set(slog.LevelInfo)
	case "warn":
		logLevel.Set(slog.LevelWarn)
	case "error":
		logLevel.Set(slog.LevelError)
	default:
		logLevel.Set(slog.LevelInfo)
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level: logLevel,
	}))
	slog.SetDefault(logger)

	slog.Info("starting capown-master",
		"version", version.ProductVersion,
		"addr", cfg.Master.Addr(),
		"db", cfg.Master.DBPath,
	)

	// Create the HTTP server
	srv, err := httpapi.NewServer(cfg)
	if err != nil {
		slog.Error("failed to create server", "error", err)
		os.Exit(1)
	}

	// Set up graceful shutdown
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		sig := <-sigCh
		slog.Info("received signal, shutting down", "signal", sig)
		cancel()

		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()

		if err := srv.Shutdown(shutdownCtx); err != nil {
			slog.Error("shutdown error", "error", err)
		}
	}()

	// Start server
	if err := srv.Start(ctx); err != nil {
		slog.Error("server error", "error", err)
		os.Exit(1)
	}

	slog.Info("server stopped")
}
