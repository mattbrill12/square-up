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

func randUint32() uint32 {
	return binary.BigEndian.Uint32(randomBytes(4))
}
