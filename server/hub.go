package main

import (
	"encoding/json"
	"sync"
)

// Hub fans out broadcast messages to all WebSocket clients subscribed to a pool ID.
type Hub struct {
	mu      sync.RWMutex
	clients map[string]map[*client]struct{} // poolID -> set of clients
}

func NewHub() *Hub {
	return &Hub{clients: map[string]map[*client]struct{}{}}
}

func (h *Hub) register(poolID string, c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[poolID]; !ok {
		h.clients[poolID] = map[*client]struct{}{}
	}
	h.clients[poolID][c] = struct{}{}
}

func (h *Hub) unregister(poolID string, c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if set, ok := h.clients[poolID]; ok {
		delete(set, c)
		if len(set) == 0 {
			delete(h.clients, poolID)
		}
	}
}

func (h *Hub) Count(poolID string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients[poolID])
}

// Broadcast marshals msg as JSON and sends it to every client subscribed to poolID.
func (h *Hub) Broadcast(poolID string, msg any) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	h.mu.RLock()
	set := h.clients[poolID]
	clients := make([]*client, 0, len(set))
	for c := range set {
		clients = append(clients, c)
	}
	h.mu.RUnlock()
	for _, c := range clients {
		select {
		case c.send <- data:
		default:
			// Client buffer full; drop. Read pump will close on next failure.
		}
	}
}
