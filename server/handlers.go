package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

type Server struct {
	store    *Store
	hub      *Hub
	espn     *Espn
	upgrader websocket.Upgrader
}

func NewServer(store *Store, hub *Hub, espn *Espn, allowedOrigin string) *Server {
	return &Server{
		store: store,
		hub:   hub,
		espn:  espn,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin: func(r *http.Request) bool {
				if allowedOrigin == "" || allowedOrigin == "*" {
					return true
				}
				return r.Header.Get("Origin") == allowedOrigin
			},
		},
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return ""
	}
	return strings.TrimPrefix(h, "Bearer ")
}

// --- Auth resolution ---

type authResult struct {
	isHost   bool
	playerID string
}

// resolveAuth identifies whether the caller is the host of the pool, a player in
// the pool, or unauthenticated. Returns authResult with zero values + nil if no
// matching token. Errors only on store failures.
func (s *Server) resolveAuth(poolID string, r *http.Request) (authResult, error) {
	tok := bearerToken(r)
	if tok == "" {
		return authResult{}, nil
	}
	hostTok, err := s.store.HostToken(poolID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return authResult{}, err
	}
	if hostTok == tok {
		return authResult{isHost: true}, nil
	}
	pid, ppid, err := s.store.PlayerByToken(tok)
	if err != nil {
		return authResult{}, err
	}
	if pid == poolID && ppid != "" {
		return authResult{playerID: ppid}, nil
	}
	return authResult{}, nil
}

// --- /api/games/today ---

func (s *Server) handleGames(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	games, err := s.espn.FetchScoreboard(ctx)
	if err != nil && !IsMockEnabled() {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if IsMockEnabled() {
		games = append([]GameSummary{MockGameSummary()}, games...)
	}
	writeJSON(w, http.StatusOK, map[string]any{"games": games})
}

// --- POST /api/pools ---

func (s *Server) handleCreatePool(w http.ResponseWriter, r *http.Request) {
	var body struct {
		EventID           string   `json:"eventId"`
		HostName          string   `json:"hostName"`
		BubbleIntervalSec int      `json:"bubbleIntervalSec"`
		AdditionalPlayers []string `json:"additionalPlayers"`
	}
	if r.ContentLength > 0 {
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<14)).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
	}
	hostName := strings.TrimSpace(body.HostName)
	if hostName == "" {
		hostName = "Host"
	}
	if body.EventID == "" {
		writeErr(w, http.StatusBadRequest, "eventId required")
		return
	}

	var game *GameInfo
	if IsMockEventID(body.EventID) {
		if !IsMockEnabled() {
			writeErr(w, http.StatusBadRequest, "mock event ids require MOCK_LIVE=1")
			return
		}
		game = MockGameInfo(body.EventID)
	} else {
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		live, fetched, err := s.espn.FetchSummary(ctx, body.EventID)
		if err != nil {
			writeErr(w, http.StatusBadGateway, "fetch game: "+err.Error())
			return
		}
		if live != nil && live.State == "post" {
			writeErr(w, http.StatusBadRequest, "this game has already ended; pick a current or upcoming game")
			return
		}
		game = fetched
	}

	state := newPoolState(game, body.BubbleIntervalSec)
	pool, hostToken, err := s.store.CreatePool(state)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	updatedPool, hostPlayer, hostPlayerToken, err := s.store.AddPlayer(pool.ID, hostName, true)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "add host player: "+err.Error())
		return
	}

	// Optional preset members — created as unclaimed seats so others can take them.
	for _, raw := range body.AdditionalPlayers {
		name := strings.TrimSpace(raw)
		if name == "" {
			continue
		}
		if len(name) > 24 {
			name = name[:24]
		}
		if name == hostName {
			continue
		}
		p, _, _, addErr := s.store.AddPlayer(pool.ID, name, false)
		if addErr != nil {
			continue
		}
		updatedPool = p
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":              updatedPool.ID,
		"hostToken":       hostToken,
		"hostPlayerId":    hostPlayer.ID,
		"hostPlayerToken": hostPlayerToken,
		"state":           updatedPool.State,
		"createdAt":       updatedPool.CreatedAt,
		"updatedAt":       updatedPool.UpdatedAt,
	})
}

// --- GET /api/pools/:id ---

func (s *Server) handleGetPool(w http.ResponseWriter, _ *http.Request, id string) {
	pool, err := s.store.GetPool(id)
	if errors.Is(err, ErrNotFound) {
		writeErr(w, http.StatusNotFound, "pool not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, pool)
}

// --- PATCH /api/pools/:id ---

func (s *Server) handlePatchPool(w http.ResponseWriter, r *http.Request, id string) {
	auth, err := s.resolveAuth(id, r)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !auth.isHost {
		writeErr(w, http.StatusForbidden, "host token required")
		return
	}
	pool, err := s.store.GetPool(id)
	if errors.Is(err, ErrNotFound) {
		writeErr(w, http.StatusNotFound, "pool not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<16))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "read body")
		return
	}
	if err := pool.State.ApplyHostPatch(body); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	updated, err := s.store.SaveState(id, pool.State)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.hub.Broadcast(id, map[string]any{"type": "state", "pool": updated})
	writeJSON(w, http.StatusOK, updated)
}

// --- POST /api/pools/:id/players ---

func (s *Server) handleJoinPool(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<13)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeErr(w, http.StatusBadRequest, "name required")
		return
	}
	if len(name) > 24 {
		name = name[:24]
	}
	pool, player, token, err := s.store.AddPlayer(id, name, true)
	if errors.Is(err, ErrNotFound) {
		writeErr(w, http.StatusNotFound, "pool not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.hub.Broadcast(id, map[string]any{"type": "state", "pool": pool})
	writeJSON(w, http.StatusCreated, map[string]any{
		"playerId":    player.ID,
		"playerToken": token,
		"state":       pool.State,
	})
}

// --- PATCH /api/pools/:id/players/:playerId ---

func (s *Server) handleRenamePlayer(w http.ResponseWriter, r *http.Request, id, playerID string) {
	auth, err := s.resolveAuth(id, r)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !auth.isHost && auth.playerID != playerID {
		writeErr(w, http.StatusForbidden, "must be host or the player themselves")
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<13)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeErr(w, http.StatusBadRequest, "name required")
		return
	}
	if len(name) > 24 {
		name = name[:24]
	}
	pool, err := s.store.RenamePlayer(id, playerID, name)
	if errors.Is(err, ErrNotFound) {
		writeErr(w, http.StatusNotFound, "pool not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.hub.Broadcast(id, map[string]any{"type": "state", "pool": pool})
	writeJSON(w, http.StatusOK, pool)
}

// --- POST /api/pools/:id/snapshot ---

func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request, id string) {
	auth, err := s.resolveAuth(id, r)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !auth.isHost {
		writeErr(w, http.StatusForbidden, "host token required")
		return
	}

	pool, err := s.store.GetPool(id)
	if errors.Is(err, ErrNotFound) {
		writeErr(w, http.StatusNotFound, "pool not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if pool.State.Live == nil || pool.State.Live.State != "in" {
		writeErr(w, http.StatusBadRequest, "snapshots only during live gameplay")
		return
	}
	if isHalftimeDetail(pool.State.Live.Detail) {
		writeErr(w, http.StatusBadRequest, "snapshots paused during halftime")
		return
	}
	if !pool.State.Revealed {
		writeErr(w, http.StatusBadRequest, "lock the board first")
		return
	}

	updated, ok, err := s.store.AppendBubbleSnapshot(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !ok {
		writeErr(w, http.StatusBadRequest, "no bubble to snapshot")
		return
	}
	s.hub.Broadcast(id, map[string]any{"type": "state", "pool": updated})
	writeJSON(w, http.StatusOK, updated)
}

// --- POST /api/pools/:id/players/:playerId/claim ---

func (s *Server) handleClaimPlayer(w http.ResponseWriter, r *http.Request, id, playerID string) {
	var body struct {
		Name string `json:"name"`
	}
	if r.ContentLength > 0 {
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<13)).Decode(&body)
	}
	name := strings.TrimSpace(body.Name)
	if len(name) > 24 {
		name = name[:24]
	}
	pool, token, err := s.store.ClaimPlayer(id, playerID, name)
	if errors.Is(err, ErrNotFound) {
		writeErr(w, http.StatusNotFound, "pool not found")
		return
	}
	if errors.Is(err, errSeatTaken) {
		writeErr(w, http.StatusConflict, "seat already taken")
		return
	}
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.hub.Broadcast(id, map[string]any{"type": "state", "pool": pool})
	writeJSON(w, http.StatusOK, map[string]any{
		"playerId":    playerID,
		"playerToken": token,
		"state":       pool.State,
	})
}

// --- DELETE /api/pools/:id/players/:playerId ---

func (s *Server) handleRemovePlayer(w http.ResponseWriter, r *http.Request, id, playerID string) {
	auth, err := s.resolveAuth(id, r)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !auth.isHost && auth.playerID != playerID {
		writeErr(w, http.StatusForbidden, "must be host or the player themselves")
		return
	}
	pool, err := s.store.RemovePlayer(id, playerID)
	if errors.Is(err, ErrNotFound) {
		writeErr(w, http.StatusNotFound, "pool not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.hub.Broadcast(id, map[string]any{"type": "state", "pool": pool})
	writeJSON(w, http.StatusOK, pool)
}

// --- POST /api/pools/:id/squares/:idx/claim ---
// --- DELETE /api/pools/:id/squares/:idx ---

func (s *Server) handleSquareAction(w http.ResponseWriter, r *http.Request, id, idxStr string, claim bool) {
	auth, err := s.resolveAuth(id, r)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !auth.isHost && auth.playerID == "" {
		writeErr(w, http.StatusUnauthorized, "auth required")
		return
	}
	idx, err := strconv.Atoi(idxStr)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid cell index")
		return
	}
	pool, err := s.store.GetPool(id)
	if errors.Is(err, ErrNotFound) {
		writeErr(w, http.StatusNotFound, "pool not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	playerID := auth.playerID
	if claim {
		var body struct {
			PlayerID string `json:"playerId"`
		}
		if r.ContentLength > 0 {
			_ = json.NewDecoder(io.LimitReader(r.Body, 1<<13)).Decode(&body)
		}
		if body.PlayerID != "" {
			if !auth.isHost && body.PlayerID != auth.playerID {
				writeErr(w, http.StatusForbidden, "cannot claim for another player")
				return
			}
			playerID = body.PlayerID
		}
		if playerID == "" {
			writeErr(w, http.StatusBadRequest, "playerId required when host claims")
			return
		}
		if err := pool.State.ClaimSquare(idx, playerID); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	} else {
		if err := pool.State.UnclaimSquare(idx, playerID, auth.isHost); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	updated, err := s.store.SaveState(id, pool.State)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.hub.Broadcast(id, map[string]any{"type": "state", "pool": updated})
	writeJSON(w, http.StatusOK, updated)
}

// --- POST /api/pools/:id/players/:playerId/push-token ---

func (s *Server) handleSetPushToken(w http.ResponseWriter, r *http.Request, id, playerID string) {
	auth, err := s.resolveAuth(id, r)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !auth.isHost && auth.playerID != playerID {
		writeErr(w, http.StatusForbidden, "must be host or the player themselves")
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<13)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if err := s.store.SetPushToken(id, playerID, body.Token); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// --- GET /api/pools/:id/ws ---

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request, id string) {
	pool, err := s.store.GetPool(id)
	if errors.Is(err, ErrNotFound) {
		writeErr(w, http.StatusNotFound, "pool not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade: %v", err)
		return
	}
	c := newClient(conn)
	s.hub.register(id, c)
	defer func() {
		s.hub.unregister(id, c)
		c.close()
	}()
	initial, _ := json.Marshal(map[string]any{"type": "state", "pool": pool})
	c.send <- initial
	go c.writePump()
	c.readPump()
}

// --- WebSocket client plumbing ---

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 4096
)

type client struct {
	conn *websocket.Conn
	send chan []byte
}

func newClient(conn *websocket.Conn) *client {
	return &client{conn: conn, send: make(chan []byte, 16)}
}

func (c *client) close() {
	close(c.send)
	_ = c.conn.Close()
}

func (c *client) readPump() {
	c.conn.SetReadLimit(maxMessageSize)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	for {
		if _, _, err := c.conn.ReadMessage(); err != nil {
			return
		}
	}
}

func (c *client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	for {
		select {
		case msg, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
