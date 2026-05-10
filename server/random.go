package main

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
)

func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

func randomHex(n int) string {
	return hex.EncodeToString(randomBytes(n))
}

// randomDigits returns a permutation of 0..9 using crypto/rand.
func randomDigits() []int {
	d := []int{0, 1, 2, 3, 4, 5, 6, 7, 8, 9}
	for i := len(d) - 1; i > 0; i-- {
		j := int(randUint32() % uint32(i+1))
		d[i], d[j] = d[j], d[i]
	}
	return d
}

// randomAssignments distributes 100 cells evenly across the players, returning
// a length-100 slice of player IDs. Cells are randomly permuted so each player
// gets a roughly-equal share in unpredictable positions.
func randomAssignments(players []Player) []string {
	out := make([]string, BoardCells)
	if len(players) == 0 {
		return out
	}
	indices := make([]int, BoardCells)
	for i := range indices {
		indices[i] = i
	}
	for i := len(indices) - 1; i > 0; i-- {
		j := int(randUint32() % uint32(i+1))
		indices[i], indices[j] = indices[j], indices[i]
	}
	n := len(players)
	for i, cellIdx := range indices {
		out[cellIdx] = players[i%n].ID
	}
	return out
}

func randUint32() uint32 {
	return binary.BigEndian.Uint32(randomBytes(4))
}
