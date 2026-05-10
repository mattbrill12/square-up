package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"
)

const (
	espnSummaryURL    = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=%s"
	espnScoreboardURL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"
	espnPollInterval  = 10 * time.Second
)

type espnSummary struct {
	Header struct {
		Competitions []espnCompetition `json:"competitions"`
	} `json:"header"`
}

type espnCompetition struct {
	Date        string           `json:"date"`
	Competitors []espnCompetitor `json:"competitors"`
	Status      struct {
		Type struct {
			State       string `json:"state"`
			Detail      string `json:"detail"`
			ShortDetail string `json:"shortDetail"`
		} `json:"type"`
	} `json:"status"`
}

type espnCompetitor struct {
	Score    string `json:"score"`
	HomeAway string `json:"homeAway"`
	Team     struct {
		Abbreviation string `json:"abbreviation"`
		DisplayName  string `json:"displayName"`
		Name         string `json:"name"`
	} `json:"team"`
}

type espnScoreboard struct {
	Events []struct {
		ID           string            `json:"id"`
		Date         string            `json:"date"`
		Name         string            `json:"name"`
		ShortName    string            `json:"shortName"`
		Competitions []espnCompetition `json:"competitions"`
	} `json:"events"`
}

type GameSummary struct {
	EventID    string `json:"eventId"`
	Date       string `json:"date"`
	Name       string `json:"name"`
	HomeAbbrev string `json:"homeAbbrev"`
	AwayAbbrev string `json:"awayAbbrev"`
	HomeName   string `json:"homeName"`
	AwayName   string `json:"awayName"`
	State      string `json:"state"`
	Detail     string `json:"detail"`
}

type Espn struct {
	client *http.Client
}

func NewEspn() *Espn {
	return &Espn{client: &http.Client{Timeout: 8 * time.Second}}
}

func (e *Espn) get(ctx context.Context, url string, out any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "square-up/1.0")
	resp, err := e.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("ESPN HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// FetchSummary returns Live + GameInfo for a single event.
func (e *Espn) FetchSummary(ctx context.Context, eventID string) (*Live, *GameInfo, error) {
	var s espnSummary
	if err := e.get(ctx, fmt.Sprintf(espnSummaryURL, eventID), &s); err != nil {
		return nil, nil, err
	}
	if len(s.Header.Competitions) == 0 {
		return nil, nil, fmt.Errorf("no competition in ESPN response")
	}
	comp := s.Header.Competitions[0]
	game := compToGameInfo(eventID, comp)
	live := &Live{
		State:     comp.Status.Type.State,
		Detail:    pickDetail(comp.Status.Type.ShortDetail, comp.Status.Type.Detail),
		FetchedAt: time.Now().Unix(),
	}
	for _, c := range comp.Competitors {
		score, _ := strconv.Atoi(c.Score)
		switch c.HomeAway {
		case "home":
			live.Home = score
		case "away":
			live.Away = score
		}
	}
	return live, game, nil
}

// FetchScoreboard returns today's NBA games.
func (e *Espn) FetchScoreboard(ctx context.Context) ([]GameSummary, error) {
	var sb espnScoreboard
	if err := e.get(ctx, espnScoreboardURL, &sb); err != nil {
		return nil, err
	}
	out := make([]GameSummary, 0, len(sb.Events))
	for _, ev := range sb.Events {
		if len(ev.Competitions) == 0 {
			continue
		}
		comp := ev.Competitions[0]
		gi := compToGameInfo(ev.ID, comp)
		out = append(out, GameSummary{
			EventID:    ev.ID,
			Date:       ev.Date,
			Name:       ev.Name,
			HomeAbbrev: gi.HomeAbbrev,
			AwayAbbrev: gi.AwayAbbrev,
			HomeName:   gi.HomeName,
			AwayName:   gi.AwayName,
			State:      comp.Status.Type.State,
			Detail:     pickDetail(comp.Status.Type.ShortDetail, comp.Status.Type.Detail),
		})
	}
	return out, nil
}

func compToGameInfo(eventID string, comp espnCompetition) *GameInfo {
	gi := &GameInfo{EventID: eventID, Date: comp.Date}
	for _, c := range comp.Competitors {
		switch c.HomeAway {
		case "home":
			gi.HomeAbbrev = c.Team.Abbreviation
			gi.HomeName = displayTeam(c)
		case "away":
			gi.AwayAbbrev = c.Team.Abbreviation
			gi.AwayName = displayTeam(c)
		}
	}
	return gi
}

func displayTeam(c espnCompetitor) string {
	if c.Team.DisplayName != "" {
		return c.Team.DisplayName
	}
	return c.Team.Name
}

func pickDetail(short, full string) string {
	if short != "" {
		return short
	}
	return full
}

// Poller fans out periodic updates from ESPN to all active pools.
type Poller struct {
	store       *Store
	hub         *Hub
	espn        *Espn
	pusher      *Pusher
	mu          sync.Mutex
	lastTick    map[string]int64 // poolID -> last bubble snapshot ts (time-based mode)
	lastQuarter map[string]int   // poolID -> last quarter index (EOQ mode)
}

func NewPoller(store *Store, hub *Hub, espn *Espn, pusher *Pusher) *Poller {
	return &Poller{
		store:       store,
		hub:         hub,
		espn:        espn,
		pusher:      pusher,
		lastTick:    map[string]int64{},
		lastQuarter: map[string]int{},
	}
}

func (p *Poller) Run(ctx context.Context) {
	t := time.NewTicker(espnPollInterval)
	defer t.Stop()
	p.tick(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.tick(ctx)
		}
	}
}

func (p *Poller) tick(ctx context.Context) {
	ids, err := p.store.ActivePoolIDs()
	if err != nil {
		log.Printf("poller list: %v", err)
		return
	}
	for _, id := range ids {
		if p.hub.Count(id) == 0 {
			continue
		}
		if err := p.pollPool(ctx, id); err != nil {
			log.Printf("poller %s: %v", id, err)
		}
	}
}

func (p *Poller) pollPool(ctx context.Context, id string) error {
	pool, err := p.store.GetPool(id)
	if err != nil {
		return err
	}
	if pool.State.Game == nil || pool.State.Game.EventID == "" {
		return nil
	}
	if IsMockEventID(pool.State.Game.EventID) {
		// Mock pools are driven exclusively by /api/pools/:id/mock-live; skip.
		return nil
	}
	live, game, err := p.espn.FetchSummary(ctx, pool.State.Game.EventID)
	if err != nil {
		return err
	}

	prev := pool.State.Live
	pool.State.Live = live
	if pool.State.Game.HomeAbbrev == "" || pool.State.Game.AwayAbbrev == "" {
		pool.State.Game = game
	}

	// Decide whether to record a bubble history entry on this tick.
	intervalSec := int64(pool.State.BubbleIntervalSec)
	isEOQ := pool.State.BubbleIntervalSec == 0
	now := live.FetchedAt

	shouldSample := false

	if isEOQ {
		currentQ := parseQuarterIndex(live.Detail)
		p.mu.Lock()
		prevQ := p.lastQuarter[id]
		p.mu.Unlock()
		if prevQ == 0 {
			// Bootstrap from existing history's last seen quarter, if any.
			if n := len(pool.State.BubbleHistory); n > 0 {
				prevQ = parseQuarterIndex(pool.State.BubbleHistory[n-1].Detail)
			}
		}
		if currentQ > 0 && currentQ > prevQ && live.State == "in" {
			shouldSample = true
			p.mu.Lock()
			p.lastQuarter[id] = currentQ
			p.mu.Unlock()
		}
	} else {
		p.mu.Lock()
		last := p.lastTick[id]
		p.mu.Unlock()
		if last == 0 {
			if n := len(pool.State.BubbleHistory); n > 0 {
				last = pool.State.BubbleHistory[n-1].TS
			}
		}
		if (now-last) >= intervalSec && live.State == "in" && !isHalftimeDetail(live.Detail) {
			shouldSample = true
		}
	}

	if shouldSample {
		if entry := pool.State.ComputeBubble(); entry != nil {
			pool.State.BubbleHistory = append(pool.State.BubbleHistory, *entry)
			if len(pool.State.BubbleHistory) > MaxBubbleHistory {
				pool.State.BubbleHistory = pool.State.BubbleHistory[len(pool.State.BubbleHistory)-MaxBubbleHistory:]
			}
			if !isEOQ {
				p.mu.Lock()
				p.lastTick[id] = now
				p.mu.Unlock()
			}
		}
	}

	// Auto-record final winner + final bubble entry when the game flips to post.
	if live.State == "post" && (prev == nil || prev.State != "post") {
		if entry := pool.State.ComputeBubble(); entry != nil {
			pool.State.BubbleHistory = append(pool.State.BubbleHistory, *entry)
			if len(pool.State.BubbleHistory) > MaxBubbleHistory {
				pool.State.BubbleHistory = pool.State.BubbleHistory[len(pool.State.BubbleHistory)-MaxBubbleHistory:]
			}
			if _, has := pool.State.Winners["final"]; !has {
				pool.State.Winners["final"] = Winner{
					Home:     live.Home,
					Away:     live.Away,
					Row:      entry.Row,
					Col:      entry.Col,
					PlayerID: entry.PlayerID,
				}
				if entry.PlayerID != "" && p.pusher != nil {
					p.notifyWinner(id, "final", entry.PlayerID, live.Home, live.Away)
				}
			}
		}
	}

	updated, err := p.store.SaveState(id, pool.State)
	if err != nil {
		return err
	}
	p.hub.Broadcast(id, map[string]any{"type": "state", "pool": updated})
	return nil
}

func (p *Poller) notifyWinner(poolID, quarter, playerID string, home, away int) {
	tok, err := p.store.PushTokenForPlayer(poolID, playerID)
	if err != nil || tok == "" {
		return
	}
	title := "Your square won " + quarter + "!"
	body := fmt.Sprintf("%d–%d. Time to drink 🍻", home, away)
	if err := p.pusher.Send(tok, title, body, map[string]any{
		"poolId":   poolID,
		"quarter":  quarter,
		"playerId": playerID,
	}); err != nil {
		log.Printf("push %s: %v", playerID, err)
	}
}
