package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// IsMockEnabled reports whether the dev MOCK_LIVE override is on.
func IsMockEnabled() bool {
	return os.Getenv("MOCK_LIVE") == "1"
}

// IsMockEventID reports whether the eventId is a synthetic mock id.
func IsMockEventID(id string) bool {
	return strings.HasPrefix(id, "MOCK_")
}

// MockGameInfo returns a canned GameInfo for a mock event id.
func MockGameInfo(eventID string) *GameInfo {
	suffix := strings.TrimPrefix(eventID, "MOCK_")
	if suffix == "" {
		suffix = "TEST"
	}
	return &GameInfo{
		EventID:    eventID,
		Date:       time.Now().UTC().Format(time.RFC3339),
		HomeAbbrev: "MCK",
		AwayAbbrev: "TST",
		HomeName:   "Mock Mavericks",
		AwayName:   "Test Tigers",
	}
}

// MockGameSummary returns a canned game for the today list.
func MockGameSummary() GameSummary {
	g := MockGameInfo("MOCK_TODAY")
	return GameSummary{
		EventID:    g.EventID,
		Date:       g.Date,
		Name:       g.AwayName + " at " + g.HomeName,
		HomeAbbrev: g.HomeAbbrev,
		AwayAbbrev: g.AwayAbbrev,
		HomeName:   g.HomeName,
		AwayName:   g.AwayName,
		State:      "pre",
		Detail:     "Mock — set live scores from the host panel",
	}
}

// --- POST /api/pools/:id/mock-live ---

func (s *Server) handleMockLive(w http.ResponseWriter, r *http.Request, id string) {
	if !IsMockEnabled() {
		writeErr(w, http.StatusNotFound, "mock disabled")
		return
	}
	auth, err := s.resolveAuth(id, r)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !auth.isHost {
		writeErr(w, http.StatusForbidden, "host token required")
		return
	}

	var body struct {
		State  string `json:"state"`
		Home   int    `json:"home"`
		Away   int    `json:"away"`
		Detail string `json:"detail"`
		Sample bool   `json:"sample"` // if true, append to bubbleHistory regardless of interval
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<14)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	switch body.State {
	case "pre", "in", "post":
	default:
		writeErr(w, http.StatusBadRequest, "state must be pre, in, or post")
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

	pool.State.Live = &Live{
		State:     body.State,
		Detail:    body.Detail,
		Home:      body.Home,
		Away:      body.Away,
		FetchedAt: time.Now().Unix(),
	}

	if body.Sample && body.State == "in" {
		if entry := pool.State.ComputeBubble(); entry != nil {
			pool.State.BubbleHistory = append(pool.State.BubbleHistory, *entry)
			if len(pool.State.BubbleHistory) > MaxBubbleHistory {
				pool.State.BubbleHistory = pool.State.BubbleHistory[len(pool.State.BubbleHistory)-MaxBubbleHistory:]
			}
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
