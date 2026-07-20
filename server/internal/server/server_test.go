package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestStatusAndConnections(t *testing.T) {
	s := New(Config{Version: "test", Host: "127.0.0.1", Port: 10089}, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/status", nil)
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status code %d body %s", rec.Code, rec.Body.String())
	}
	var status map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status["running"] != true || status["extension_connected"] != false {
		t.Fatalf("unexpected status %#v", status)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/connections", nil)
	rec = httptest.NewRecorder()
	s.Router().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("connections code %d body %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "ws://127.0.0.1:10089/ws") {
		t.Fatalf("unexpected connection response %s", rec.Body.String())
	}
}

func TestCommandRequiresExtension(t *testing.T) {
	s := New(Config{Version: "test"}, nil, nil)
	body := bytes.NewBufferString(`{"action":"snapshot","args":{}}`)
	req := httptest.NewRequest(http.MethodPost, "/command", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("code %d body %s", rec.Code, rec.Body.String())
	}
}

func TestCommandOverWebSocketAndSessionInjection(t *testing.T) {
	s := New(Config{Version: "test"}, nil, nil)
	ts := httptest.NewServer(s.Router())
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	if err := conn.WriteJSON(map[string]any{
		"type": "hello",
		"payload": map[string]any{
			"extensionName":    "chrome-bridge",
			"extensionVersion": "0.1.0",
		},
	}); err != nil {
		t.Fatal(err)
	}
	var ack map[string]any
	if err := conn.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}
	if ack["type"] != "hello_ack" {
		t.Fatalf("unexpected ack %#v", ack)
	}

	go func() {
		for {
			var msg map[string]any
			if err := conn.ReadJSON(&msg); err != nil {
				return
			}
			payload := msg["payload"].(map[string]any)
			name := payload["name"].(string)
			args := payload["args"].(map[string]any)
			var data map[string]any
			switch name {
			case "navigate":
				data = map[string]any{"success": true, "url": args["url"], "tabId": 77}
			case "click":
				if args["_tabId"] != float64(77) {
					data = map[string]any{"badTab": args["_tabId"]}
				} else {
					data = map[string]any{"success": true, "tag": "BUTTON"}
				}
			default:
				data = map[string]any{"success": true}
			}
			_ = conn.WriteJSON(map[string]any{
				"type":                "tool_result",
				"responseToRequestId": msg["requestId"],
				"payload":             map[string]any{"data": data},
			})
		}
	}()

	postCommand(t, ts.URL, `{"action":"navigate","session":"task","args":{"url":"https://example.com","newTab":true}}`)
	result := postCommand(t, ts.URL, `{"action":"click","session":"task","args":{"selector":"#go"}}`)
	data := result["data"].(map[string]any)
	if data["success"] != true {
		t.Fatalf("expected success, got %#v", data)
	}
}

func TestScreenshotCommandWritesFile(t *testing.T) {
	s := New(Config{Version: "test"}, nil, nil)
	ts := httptest.NewServer(s.Router())
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.WriteJSON(map[string]any{"type": "hello", "payload": map[string]any{}}); err != nil {
		t.Fatal(err)
	}
	var ack map[string]any
	if err := conn.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}

	go func() {
		var msg map[string]any
		if err := conn.ReadJSON(&msg); err != nil {
			return
		}
		_ = conn.WriteJSON(map[string]any{
			"type":                "tool_result",
			"responseToRequestId": msg["requestId"],
			"payload": map[string]any{"data": map[string]any{
				"format": "png",
				"data":   base64.StdEncoding.EncodeToString([]byte("image")),
			}},
		})
	}()

	path := t.TempDir() + "/shot.png"
	result := postCommand(t, ts.URL, `{"action":"screenshot","args":{"path":"`+path+`"}}`)
	data := result["data"].(map[string]any)
	if data["path"] != path || data["sizeBytes"] != float64(5) {
		t.Fatalf("unexpected screenshot result %#v", data)
	}
}

func TestCommandTimeout(t *testing.T) {
	s := New(Config{Version: "test"}, nil, nil)
	ts := httptest.NewServer(s.Router())
	defer ts.Close()

	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(ts.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.WriteJSON(map[string]any{"type": "hello", "payload": map[string]any{}}); err != nil {
		t.Fatal(err)
	}
	var ack map[string]any
	if err := conn.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}
	go func() {
		var ignored map[string]any
		_ = conn.ReadJSON(&ignored)
		time.Sleep(50 * time.Millisecond)
	}()

	body := bytes.NewBufferString(`{"action":"snapshot","args":{},"timeout_ms":10}`)
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/command", body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusGatewayTimeout {
		t.Fatalf("expected timeout status, got %d", resp.StatusCode)
	}
}

func postCommand(t *testing.T, baseURL, body string) map[string]any {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, baseURL+"/command", bytes.NewBufferString(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var result map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("code %d body %#v", resp.StatusCode, result)
	}
	return result
}
