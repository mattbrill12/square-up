package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	_ "modernc.org/sqlite"
)

var (
	ErrNotFound  = errors.New("pool not found")
	errSeatTaken = errors.New("seat already taken")
)

type Store struct {
	db *sql.DB
}

func OpenStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(on)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS pools (
			id TEXT PRIMARY KEY,
			host_token TEXT NOT NULL,
			state TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS player_tokens (
			pool_id TEXT NOT NULL,
			player_id TEXT NOT NULL,
			token TEXT NOT NULL,
			push_token TEXT,
			PRIMARY KEY (pool_id, player_id)
		);
		CREATE INDEX IF NOT EXISTS idx_player_tokens_token ON player_tokens(token);
	`); err != nil {
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// CreatePool creates a pool with the given initial state and returns the pool + its host token.
func (s *Store) CreatePool(initial PoolState) (*Pool, string, error) {
	initial.ensureInvariants()
	if err := initial.Validate(); err != nil {
		return nil, "", err
	}
	id := randomHex(4)
	token := randomHex(16)
	now := time.Now().Unix()
	stateJSON, err := json.Marshal(initial)
	if err != nil {
		return nil, "", err
	}
	_, err = s.db.Exec(
		`INSERT INTO pools (id, host_token, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
		id, token, string(stateJSON), now, now,
	)
	if err != nil {
		return nil, "", err
	}
	return &Pool{ID: id, State: initial, CreatedAt: now, UpdatedAt: now}, token, nil
}

func (s *Store) GetPool(id string) (*Pool, error) {
	var stateJSON string
	var created, updated int64
	err := s.db.QueryRow(
		`SELECT state, created_at, updated_at FROM pools WHERE id = ?`, id,
	).Scan(&stateJSON, &created, &updated)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var st PoolState
	if err := json.Unmarshal([]byte(stateJSON), &st); err != nil {
		return nil, err
	}
	st.ensureInvariants()
	return &Pool{ID: id, State: st, CreatedAt: created, UpdatedAt: updated}, nil
}

func (s *Store) HostToken(id string) (string, error) {
	var t string
	err := s.db.QueryRow(`SELECT host_token FROM pools WHERE id = ?`, id).Scan(&t)
	if err == sql.ErrNoRows {
		return "", ErrNotFound
	}
	return t, err
}

// SaveState writes a new state for a pool.
func (s *Store) SaveState(id string, state PoolState) (*Pool, error) {
	state.ensureInvariants()
	if err := state.Validate(); err != nil {
		return nil, err
	}
	stateJSON, err := json.Marshal(state)
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	res, err := s.db.Exec(
		`UPDATE pools SET state = ?, updated_at = ? WHERE id = ?`,
		string(stateJSON), now, id,
	)
	if err != nil {
		return nil, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, ErrNotFound
	}
	return s.GetPool(id)
}

// AddPlayer creates a player inside a pool with a fresh token. Returns the new
// player + its token. The `claimed` flag should be true when a real device is
// taking the seat (self-join, host themselves) and false for host-created
// preset seats waiting to be claimed by someone else.
func (s *Store) AddPlayer(poolID, name string, claimed bool) (*Pool, *Player, string, error) {
	pool, err := s.GetPool(poolID)
	if err != nil {
		return nil, nil, "", err
	}
	playerID := randomHex(4)
	color := pickColor(len(pool.State.Players))
	player := Player{ID: playerID, Name: name, Color: color, Claimed: claimed}
	if err := pool.State.AddPlayer(player); err != nil {
		return nil, nil, "", err
	}
	playerToken := randomHex(16)
	tx, err := s.db.Begin()
	if err != nil {
		return nil, nil, "", err
	}
	defer func() { _ = tx.Rollback() }()

	stateJSON, err := json.Marshal(pool.State)
	if err != nil {
		return nil, nil, "", err
	}
	now := time.Now().Unix()
	if _, err := tx.Exec(
		`UPDATE pools SET state = ?, updated_at = ? WHERE id = ?`,
		string(stateJSON), now, poolID,
	); err != nil {
		return nil, nil, "", err
	}
	if _, err := tx.Exec(
		`INSERT INTO player_tokens (pool_id, player_id, token) VALUES (?, ?, ?)`,
		poolID, playerID, playerToken,
	); err != nil {
		return nil, nil, "", err
	}
	if err := tx.Commit(); err != nil {
		return nil, nil, "", err
	}
	pool.UpdatedAt = now
	return pool, &player, playerToken, nil
}

// RemovePlayer removes a player + their token. Returns the updated pool.
func (s *Store) RemovePlayer(poolID, playerID string) (*Pool, error) {
	pool, err := s.GetPool(poolID)
	if err != nil {
		return nil, err
	}
	if !pool.State.RemovePlayer(playerID) {
		return pool, nil
	}

	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	stateJSON, err := json.Marshal(pool.State)
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	if _, err := tx.Exec(
		`UPDATE pools SET state = ?, updated_at = ? WHERE id = ?`,
		string(stateJSON), now, poolID,
	); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(
		`DELETE FROM player_tokens WHERE pool_id = ? AND player_id = ?`,
		poolID, playerID,
	); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	pool.UpdatedAt = now
	return pool, nil
}

// RenamePlayer updates the display name for an existing player without
// touching tokens. Returns the updated pool.
func (s *Store) RenamePlayer(poolID, playerID, name string) (*Pool, error) {
	pool, err := s.GetPool(poolID)
	if err != nil {
		return nil, err
	}
	idx := -1
	for i, p := range pool.State.Players {
		if p.ID == playerID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return nil, errors.New("player not found")
	}
	pool.State.Players[idx].Name = name

	stateJSON, err := json.Marshal(pool.State)
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	if _, err := s.db.Exec(
		`UPDATE pools SET state = ?, updated_at = ? WHERE id = ?`,
		string(stateJSON), now, poolID,
	); err != nil {
		return nil, err
	}
	pool.UpdatedAt = now
	return pool, nil
}

// AppendBubbleSnapshot records the current bubble state immediately. Returns
// the updated pool and whether a snapshot was actually appended.
func (s *Store) AppendBubbleSnapshot(poolID string) (*Pool, bool, error) {
	pool, err := s.GetPool(poolID)
	if err != nil {
		return nil, false, err
	}
	if pool.State.Live != nil && isHalftimeDetail(pool.State.Live.Detail) {
		return pool, false, nil
	}
	entry := pool.State.ComputeBubble()
	if entry == nil {
		return pool, false, nil
	}
	pool.State.BubbleHistory = append(pool.State.BubbleHistory, *entry)
	if len(pool.State.BubbleHistory) > MaxBubbleHistory {
		pool.State.BubbleHistory = pool.State.BubbleHistory[len(pool.State.BubbleHistory)-MaxBubbleHistory:]
	}
	stateJSON, err := json.Marshal(pool.State)
	if err != nil {
		return nil, false, err
	}
	now := time.Now().Unix()
	if _, err := s.db.Exec(
		`UPDATE pools SET state = ?, updated_at = ? WHERE id = ?`,
		string(stateJSON), now, poolID,
	); err != nil {
		return nil, false, err
	}
	pool.UpdatedAt = now
	return pool, true, nil
}

// ClaimPlayer reissues the token for an existing player and optionally updates the
// display name. The previous token is invalidated. Returns the updated pool and
// new token. The pool's WS subscribers should be notified by the caller.
// Seats that are already claimed by a real device are rejected with
// errSeatTaken so the host or other players can't be impersonated.
func (s *Store) ClaimPlayer(poolID, playerID, newName string) (*Pool, string, error) {
	pool, err := s.GetPool(poolID)
	if err != nil {
		return nil, "", err
	}
	idx := -1
	for i, p := range pool.State.Players {
		if p.ID == playerID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return nil, "", errors.New("player not found")
	}
	if pool.State.Players[idx].Claimed {
		return nil, "", errSeatTaken
	}
	if newName != "" {
		pool.State.Players[idx].Name = newName
	}
	pool.State.Players[idx].Claimed = true

	tx, err := s.db.Begin()
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback() }()

	stateJSON, err := json.Marshal(pool.State)
	if err != nil {
		return nil, "", err
	}
	now := time.Now().Unix()
	if _, err := tx.Exec(
		`UPDATE pools SET state = ?, updated_at = ? WHERE id = ?`,
		string(stateJSON), now, poolID,
	); err != nil {
		return nil, "", err
	}
	newToken := randomHex(16)
	if _, err := tx.Exec(
		`UPDATE player_tokens SET token = ?, push_token = NULL WHERE pool_id = ? AND player_id = ?`,
		newToken, poolID, playerID,
	); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(); err != nil {
		return nil, "", err
	}
	pool.UpdatedAt = now
	return pool, newToken, nil
}

// PlayerByToken returns (poolID, playerID) for the given token, or empty strings if not found.
func (s *Store) PlayerByToken(token string) (string, string, error) {
	var poolID, playerID string
	err := s.db.QueryRow(
		`SELECT pool_id, player_id FROM player_tokens WHERE token = ?`, token,
	).Scan(&poolID, &playerID)
	if err == sql.ErrNoRows {
		return "", "", nil
	}
	if err != nil {
		return "", "", err
	}
	return poolID, playerID, nil
}

func (s *Store) SetPushToken(poolID, playerID, pushToken string) error {
	res, err := s.db.Exec(
		`UPDATE player_tokens SET push_token = ? WHERE pool_id = ? AND player_id = ?`,
		pushToken, poolID, playerID,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return errors.New("player not found")
	}
	return nil
}

// PushTokenForPlayer returns the Expo push token for a player, or "" if none.
func (s *Store) PushTokenForPlayer(poolID, playerID string) (string, error) {
	var t sql.NullString
	err := s.db.QueryRow(
		`SELECT push_token FROM player_tokens WHERE pool_id = ? AND player_id = ?`,
		poolID, playerID,
	).Scan(&t)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return t.String, nil
}

// ActivePoolIDs returns IDs of pools that have an associated game and aren't finalized.
func (s *Store) ActivePoolIDs() ([]string, error) {
	rows, err := s.db.Query(`SELECT id, state FROM pools`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id, stateJSON string
		if err := rows.Scan(&id, &stateJSON); err != nil {
			return nil, err
		}
		var st PoolState
		if err := json.Unmarshal([]byte(stateJSON), &st); err != nil {
			continue
		}
		if st.Game == nil || st.Game.EventID == "" {
			continue
		}
		if st.Live != nil && st.Live.State == "post" && hasFinalWinner(&st) {
			continue
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func hasFinalWinner(s *PoolState) bool {
	_, ok := s.Winners["final"]
	return ok
}

var palette = []string{
	"#e63946", "#2a9d8f", "#f4a261", "#a06cd5",
	"#ffcc33", "#00b4d8", "#ff7eb6", "#9aff66",
	"#ff8c42", "#7c83fd",
}

func pickColor(idx int) string {
	return palette[idx%len(palette)]
}
