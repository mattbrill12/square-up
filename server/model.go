package main

import (
	"encoding/json"
	"errors"
	"fmt"
)

const (
	BoardCells               = 100
	DefaultBubbleIntervalSec = 60
	MinBubbleIntervalSec     = 30
	MaxBubbleIntervalSec     = 1800
	MaxBubbleHistory         = 500
)

type Player struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

type GameInfo struct {
	EventID    string `json:"eventId"`
	Date       string `json:"date"`
	HomeAbbrev string `json:"homeAbbrev"`
	AwayAbbrev string `json:"awayAbbrev"`
	HomeName   string `json:"homeName"`
	AwayName   string `json:"awayName"`
}

type Live struct {
	State     string `json:"state"` // "pre" | "in" | "post"
	Detail    string `json:"detail"`
	Home      int    `json:"home"`
	Away      int    `json:"away"`
	FetchedAt int64  `json:"fetchedAt"`
}

type Winner struct {
	Home     int    `json:"home"`
	Away     int    `json:"away"`
	Row      int    `json:"row"`
	Col      int    `json:"col"`
	PlayerID string `json:"playerId,omitempty"`
}

type BubbleEntry struct {
	TS       int64  `json:"ts"`
	Home     int    `json:"home"`
	Away     int    `json:"away"`
	Detail   string `json:"detail"`
	Row      int    `json:"row"`
	Col      int    `json:"col"`
	PlayerID string `json:"playerId,omitempty"`
}

type PoolState struct {
	Game              *GameInfo         `json:"game,omitempty"`
	Players           []Player          `json:"players"`
	Assignments       []string          `json:"assignments"`
	RowDigits         []int             `json:"rowDigits,omitempty"`
	ColDigits         []int             `json:"colDigits,omitempty"`
	Revealed          bool              `json:"revealed"`
	Winners           map[string]Winner `json:"winners"`
	Live              *Live             `json:"live,omitempty"`
	BubbleHistory     []BubbleEntry     `json:"bubbleHistory"`
	BubbleIntervalSec int               `json:"bubbleIntervalSec"`
}

type Pool struct {
	ID        string    `json:"id"`
	State     PoolState `json:"state"`
	CreatedAt int64     `json:"createdAt"`
	UpdatedAt int64     `json:"updatedAt"`
}

func newPoolState(game *GameInfo, intervalSec int) PoolState {
	if intervalSec <= 0 {
		intervalSec = DefaultBubbleIntervalSec
	}
	return PoolState{
		Game:              game,
		Players:           []Player{},
		Assignments:       make([]string, BoardCells),
		Revealed:          false,
		Winners:           map[string]Winner{},
		BubbleHistory:     []BubbleEntry{},
		BubbleIntervalSec: intervalSec,
	}
}

func (s *PoolState) ensureInvariants() {
	if s.Players == nil {
		s.Players = []Player{}
	}
	if s.Assignments == nil || len(s.Assignments) != BoardCells {
		s.Assignments = make([]string, BoardCells)
	}
	if s.Winners == nil {
		s.Winners = map[string]Winner{}
	}
	if s.BubbleHistory == nil {
		s.BubbleHistory = []BubbleEntry{}
	}
	if s.BubbleIntervalSec < MinBubbleIntervalSec {
		s.BubbleIntervalSec = DefaultBubbleIntervalSec
	}
	if s.BubbleIntervalSec > MaxBubbleIntervalSec {
		s.BubbleIntervalSec = MaxBubbleIntervalSec
	}
}

func (s *PoolState) Validate() error {
	s.ensureInvariants()

	playerIDs := map[string]bool{}
	for _, p := range s.Players {
		if p.ID == "" || p.Name == "" {
			return errors.New("player must have id and name")
		}
		if playerIDs[p.ID] {
			return errors.New("duplicate player id")
		}
		playerIDs[p.ID] = true
	}

	if len(s.Assignments) != BoardCells {
		return errors.New("assignments must have length 100")
	}
	for _, pid := range s.Assignments {
		if pid != "" && !playerIDs[pid] {
			return fmt.Errorf("assignment references unknown player %q", pid)
		}
	}

	if len(s.RowDigits) > 0 {
		if err := validateDigits(s.RowDigits); err != nil {
			return fmt.Errorf("rowDigits: %w", err)
		}
	}
	if len(s.ColDigits) > 0 {
		if err := validateDigits(s.ColDigits); err != nil {
			return fmt.Errorf("colDigits: %w", err)
		}
	}

	for q, w := range s.Winners {
		switch q {
		case "q1", "q2", "q3", "final":
		default:
			return fmt.Errorf("invalid winner key: %s", q)
		}
		if w.Row < 0 || w.Row > 9 || w.Col < 0 || w.Col > 9 {
			return errors.New("winner row/col out of range")
		}
		if w.PlayerID != "" && !playerIDs[w.PlayerID] {
			return fmt.Errorf("winner references unknown player %q", w.PlayerID)
		}
	}

	if len(s.BubbleHistory) > MaxBubbleHistory {
		s.BubbleHistory = s.BubbleHistory[len(s.BubbleHistory)-MaxBubbleHistory:]
	}

	return nil
}

func validateDigits(d []int) error {
	if len(d) != 10 {
		return errors.New("must have length 10")
	}
	seen := [10]bool{}
	for _, n := range d {
		if n < 0 || n > 9 {
			return errors.New("digit out of range")
		}
		if seen[n] {
			return errors.New("duplicate digit")
		}
		seen[n] = true
	}
	return nil
}

// HostPatch is the subset of fields a host can set via PATCH /api/pools/:id.
type HostPatch struct {
	Revealed          *bool              `json:"revealed,omitempty"`
	BubbleIntervalSec *int               `json:"bubbleIntervalSec,omitempty"`
	Winners           *map[string]Winner `json:"winners,omitempty"`
	RowDigits         *[]int             `json:"rowDigits,omitempty"`
	ColDigits         *[]int             `json:"colDigits,omitempty"`
}

func (s *PoolState) ApplyHostPatch(raw json.RawMessage) error {
	var p HostPatch
	if err := json.Unmarshal(raw, &p); err != nil {
		return err
	}
	if p.Revealed != nil {
		s.Revealed = *p.Revealed
		if s.Revealed {
			if len(s.RowDigits) != 10 {
				s.RowDigits = randomDigits()
			}
			if len(s.ColDigits) != 10 {
				s.ColDigits = randomDigits()
			}
		}
	}
	if p.BubbleIntervalSec != nil {
		s.BubbleIntervalSec = *p.BubbleIntervalSec
	}
	if p.Winners != nil {
		s.Winners = *p.Winners
	}
	if p.RowDigits != nil {
		s.RowDigits = *p.RowDigits
	}
	if p.ColDigits != nil {
		s.ColDigits = *p.ColDigits
	}
	return s.Validate()
}

// AddPlayer appends a player. The caller is responsible for generating the ID.
func (s *PoolState) AddPlayer(p Player) error {
	for _, existing := range s.Players {
		if existing.ID == p.ID {
			return errors.New("player already exists")
		}
	}
	s.Players = append(s.Players, p)
	return nil
}

// RemovePlayer removes a player and unclaims any of their squares.
func (s *PoolState) RemovePlayer(playerID string) bool {
	idx := -1
	for i, p := range s.Players {
		if p.ID == playerID {
			idx = i
			break
		}
	}
	if idx == -1 {
		return false
	}
	s.Players = append(s.Players[:idx], s.Players[idx+1:]...)
	for i, pid := range s.Assignments {
		if pid == playerID {
			s.Assignments[i] = ""
		}
	}
	return true
}

// ClaimSquare marks cell idx as belonging to playerID. Errors if revealed
// or if the cell is already claimed by someone else.
func (s *PoolState) ClaimSquare(idx int, playerID string) error {
	if s.Revealed {
		return errors.New("board is locked; numbers revealed")
	}
	if idx < 0 || idx >= BoardCells {
		return errors.New("cell index out of range")
	}
	if s.Assignments[idx] != "" && s.Assignments[idx] != playerID {
		return errors.New("cell already claimed")
	}
	found := false
	for _, p := range s.Players {
		if p.ID == playerID {
			found = true
			break
		}
	}
	if !found {
		return errors.New("unknown player")
	}
	s.Assignments[idx] = playerID
	return nil
}

// UnclaimSquare clears cell idx if it belongs to playerID (or unconditionally
// if forceHost is true).
func (s *PoolState) UnclaimSquare(idx int, playerID string, forceHost bool) error {
	if s.Revealed {
		return errors.New("board is locked; numbers revealed")
	}
	if idx < 0 || idx >= BoardCells {
		return errors.New("cell index out of range")
	}
	if s.Assignments[idx] == "" {
		return nil
	}
	if !forceHost && s.Assignments[idx] != playerID {
		return errors.New("cell belongs to another player")
	}
	s.Assignments[idx] = ""
	return nil
}

// ComputeBubble returns the row/col + playerID of the cell the live score is on,
// or nil if there's no current bubble (game not started, no digits yet, etc.).
func (s *PoolState) ComputeBubble() *BubbleEntry {
	if s.Live == nil || s.Live.State == "pre" {
		return nil
	}
	if len(s.RowDigits) != 10 || len(s.ColDigits) != 10 {
		return nil
	}
	hDigit := mod10(s.Live.Home)
	aDigit := mod10(s.Live.Away)
	row := indexOfDigit(s.RowDigits, hDigit)
	col := indexOfDigit(s.ColDigits, aDigit)
	if row < 0 || col < 0 {
		return nil
	}
	pid := ""
	if len(s.Assignments) == BoardCells {
		pid = s.Assignments[row*10+col]
	}
	return &BubbleEntry{
		TS:       s.Live.FetchedAt,
		Home:     s.Live.Home,
		Away:     s.Live.Away,
		Detail:   s.Live.Detail,
		Row:      row,
		Col:      col,
		PlayerID: pid,
	}
}

func mod10(n int) int {
	if n < 0 {
		n = -n
	}
	return n % 10
}

func indexOfDigit(arr []int, d int) int {
	for i, v := range arr {
		if v == d {
			return i
		}
	}
	return -1
}
