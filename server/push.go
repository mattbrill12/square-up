package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const expoPushURL = "https://exp.host/--/api/v2/push/send"

type Pusher struct {
	client *http.Client
}

func NewPusher() *Pusher {
	return &Pusher{client: &http.Client{Timeout: 8 * time.Second}}
}

type expoMessage struct {
	To       string         `json:"to"`
	Title    string         `json:"title,omitempty"`
	Body     string         `json:"body,omitempty"`
	Data     map[string]any `json:"data,omitempty"`
	Sound    string         `json:"sound,omitempty"`
	Priority string         `json:"priority,omitempty"`
}

func (p *Pusher) Send(token, title, body string, data map[string]any) error {
	msg := expoMessage{
		To:       token,
		Title:    title,
		Body:     body,
		Data:     data,
		Sound:    "default",
		Priority: "high",
	}
	buf, err := json.Marshal([]expoMessage{msg})
	if err != nil {
		return err
	}
	req, err := http.NewRequest("POST", expoPushURL, bytes.NewReader(buf))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("expo push HTTP %d", resp.StatusCode)
	}
	return nil
}
