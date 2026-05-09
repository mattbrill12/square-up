package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	addr := ":" + env("PORT", "8080")
	dbPath := env("DB_PATH", "./data/squares.db")
	allowedOrigin := env("ALLOWED_ORIGIN", "*")

	if dir := filepath.Dir(dbPath); dir != "" {
		_ = os.MkdirAll(dir, 0o755)
	}

	store, err := OpenStore(dbPath)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer store.Close()

	hub := NewHub()
	espn := NewEspn()
	pusher := NewPusher()
	srv := NewServer(store, hub, espn, allowedOrigin)
	poller := NewPoller(store, hub, espn, pusher)

	mux := http.NewServeMux()

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	mux.HandleFunc("/api/games/today", func(w http.ResponseWriter, r *http.Request) {
		setCORS(w, allowedOrigin)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodGet {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		srv.handleGames(w, r)
	})

	mux.HandleFunc("/api/pools", func(w http.ResponseWriter, r *http.Request) {
		setCORS(w, allowedOrigin)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		srv.handleCreatePool(w, r)
	})

	mux.HandleFunc("/api/pools/", func(w http.ResponseWriter, r *http.Request) {
		setCORS(w, allowedOrigin)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/api/pools/")
		if path == "" {
			writeErr(w, http.StatusNotFound, "not found")
			return
		}
		parts := strings.Split(path, "/")
		id := parts[0]
		if id == "" {
			writeErr(w, http.StatusNotFound, "not found")
			return
		}

		switch len(parts) {
		case 1:
			switch r.Method {
			case http.MethodGet:
				srv.handleGetPool(w, r, id)
			case http.MethodPatch:
				srv.handlePatchPool(w, r, id)
			default:
				writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			}
		case 2:
			switch parts[1] {
			case "ws":
				if r.Method != http.MethodGet {
					writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
					return
				}
				srv.handleWS(w, r, id)
			case "players":
				if r.Method != http.MethodPost {
					writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
					return
				}
				srv.handleJoinPool(w, r, id)
			default:
				writeErr(w, http.StatusNotFound, "not found")
			}
		case 3:
			// /api/pools/:id/players/:playerId  or  /api/pools/:id/squares/:idx
			if parts[1] == "players" {
				playerID := parts[2]
				if r.Method != http.MethodDelete {
					writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
					return
				}
				srv.handleRemovePlayer(w, r, id, playerID)
				return
			}
			if parts[1] == "squares" {
				idx := parts[2]
				if r.Method != http.MethodDelete {
					writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
					return
				}
				srv.handleSquareAction(w, r, id, idx, false)
				return
			}
			writeErr(w, http.StatusNotFound, "not found")
		case 4:
			// /api/pools/:id/players/:playerId/push-token  or  /api/pools/:id/squares/:idx/claim
			if parts[1] == "players" && parts[3] == "push-token" {
				if r.Method != http.MethodPost {
					writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
					return
				}
				srv.handleSetPushToken(w, r, id, parts[2])
				return
			}
			if parts[1] == "squares" && parts[3] == "claim" {
				if r.Method != http.MethodPost {
					writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
					return
				}
				srv.handleSquareAction(w, r, id, parts[2], true)
				return
			}
			writeErr(w, http.StatusNotFound, "not found")
		default:
			writeErr(w, http.StatusNotFound, "not found")
		}
	})

	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           withLogging(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	go poller.Run(ctx)

	go func() {
		log.Printf("listening on %s (db=%s)", addr, dbPath)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down...")
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutCancel()
	_ = httpSrv.Shutdown(shutCtx)
}

func setCORS(w http.ResponseWriter, allowedOrigin string) {
	if allowedOrigin == "" {
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.Header().Set("Access-Control-Max-Age", "300")
}

func withLogging(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		h.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start))
	})
}
