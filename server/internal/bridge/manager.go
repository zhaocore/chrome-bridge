// Package bridge manages the WebSocket connection to the Chrome extension and
// routes tool calls from the HTTP API to the extension's debugger-backed tools.
//
// The extension is the single source of browser state: the daemon forwards a
// tool_call over the WebSocket and waits for the matching tool_result keyed by
// request ID. Only one extension connection is kept active at a time.
package bridge

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

var (
	// ErrExtensionNotConnected is returned when a tool call is made with no
	// extension WebSocket connected.
	ErrExtensionNotConnected = errors.New("extension not connected")
	// ErrExtensionDisconnected is returned to in-flight callers when the
	// extension WebSocket drops mid-call.
	ErrExtensionDisconnected = errors.New("extension disconnected")
)

// Logger is the minimal logging interface used by the bridge.
type Logger interface {
	Printf(format string, v ...any)
}

// noopLogger discards all log output.
type noopLogger struct{}

func (noopLogger) Printf(string, ...any) {}

// Status describes the current extension connection, surfaced via the HTTP
// /status endpoint.
type Status struct {
	Connected        bool   `json:"extension_connected"`
	ExtensionID      string `json:"extension_id"`
	ExtensionName    string `json:"extension_name,omitempty"`
	ExtensionVersion string `json:"extension_version"`
}

// Manager owns the extension WebSocket and tracks in-flight tool calls by
// request ID. It is safe for concurrent use.
type Manager struct {
	version string
	logger  Logger

	upgrader websocket.Upgrader
	nextID   atomic.Uint64

	mu      sync.Mutex
	conn    *websocket.Conn
	writeMu sync.Mutex
	// pending maps daemon request IDs to the HTTP handler waiting for the
	// matching tool_result from the extension.
	pending          map[string]chan callResult
	extensionID      string
	extensionName    string
	extensionVersion string
}

// callResult carries a tool call's outcome back to its waiting caller.
type callResult struct {
	data any
	err  error
}

// Message is the envelope exchanged with the extension over the WebSocket.
type Message struct {
	Type                string         `json:"type"`
	RequestID           string         `json:"requestId,omitempty"`
	ResponseToRequestID string         `json:"responseToRequestId,omitempty"`
	Payload             map[string]any `json:"payload,omitempty"`
}

// NewManager returns a Manager bound to the given daemon version and logger.
// A nil logger is replaced with a no-op.
func NewManager(version string, logger Logger) *Manager {
	if logger == nil {
		logger = noopLogger{}
	}
	return &Manager{
		version: version,
		logger:  logger,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(*http.Request) bool { return true },
		},
		pending: make(map[string]chan callResult),
	}
}

// Status returns a snapshot of the extension connection.
func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	return Status{
		Connected:        m.conn != nil,
		ExtensionID:      m.extensionID,
		ExtensionName:    m.extensionName,
		ExtensionVersion: m.extensionVersion,
	}
}

// ServeWS upgrades the HTTP request to the extension WebSocket and runs its
// read loop to completion. A second connection is rejected while one is active.
func (m *Manager) ServeWS(w http.ResponseWriter, r *http.Request) {
	conn, err := m.upgrader.Upgrade(w, r, nil)
	if err != nil {
		m.logger.Printf("websocket upgrade failed: %v", err)
		return
	}

	m.mu.Lock()
	// Chrome debugger attachment is global per tab, so keep one active
	// extension connection to avoid two browsers racing for the same tool calls.
	if m.conn != nil {
		m.mu.Unlock()
		_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "another extension is already connected"))
		_ = conn.Close()
		m.logger.Printf("rejected second extension connection")
		return
	}
	m.conn = conn
	m.writeMu = sync.Mutex{}
	m.mu.Unlock()

	m.logger.Printf("extension websocket connected")
	m.readLoop(conn)
}

// Call sends a tool_call to the extension and blocks until the matching
// tool_result arrives or ctx is cancelled.
func (m *Manager) Call(ctx context.Context, name string, args map[string]any) (any, error) {
	requestID := fmt.Sprintf("req-%d", m.nextID.Add(1))
	resultCh := make(chan callResult, 1)
	started := time.Now()

	m.mu.Lock()
	conn := m.conn
	if conn == nil {
		m.mu.Unlock()
		return nil, ErrExtensionNotConnected
	}
	m.pending[requestID] = resultCh
	m.mu.Unlock()

	// The extension protocol is request/response over one WebSocket: send a
	// tool_call now, then wait until handleToolResult resolves this request ID.
	message := Message{
		Type:      "tool_call",
		RequestID: requestID,
		Payload: map[string]any{
			"name": name,
			"args": args,
		},
	}
	if err := m.writeJSON(conn, message); err != nil {
		m.removePending(requestID)
		m.logger.Printf("tool_call write_error request_id=%s action=%s error=%q", requestID, name, err.Error())
		return nil, err
	}
	m.logger.Printf("tool_call sent request_id=%s action=%s", requestID, name)

	select {
	case result := <-resultCh:
		if result.err != nil {
			m.logger.Printf("tool_call result_error request_id=%s action=%s duration_ms=%d error=%q", requestID, name, time.Since(started).Milliseconds(), result.err.Error())
		} else {
			m.logger.Printf("tool_call result_ok request_id=%s action=%s duration_ms=%d", requestID, name, time.Since(started).Milliseconds())
		}
		return result.data, result.err
	case <-ctx.Done():
		m.removePending(requestID)
		m.logger.Printf("tool_call timeout request_id=%s action=%s duration_ms=%d error=%q", requestID, name, time.Since(started).Milliseconds(), ctx.Err().Error())
		return nil, ctx.Err()
	}
}

// Ping sends a low-level ping message to confirm the WebSocket is alive.
func (m *Manager) Ping(ctx context.Context) error {
	requestID := fmt.Sprintf("ping-%d", time.Now().UnixNano())
	m.mu.Lock()
	conn := m.conn
	m.mu.Unlock()
	if conn == nil {
		return ErrExtensionNotConnected
	}
	return m.writeJSON(conn, Message{Type: "ping", RequestID: requestID})
}

// readLoop reads WebSocket messages until the connection errors out, then
// disconnects.
func (m *Manager) readLoop(conn *websocket.Conn) {
	defer m.disconnect(conn)
	for {
		var msg Message
		if err := conn.ReadJSON(&msg); err != nil {
			m.logger.Printf("websocket read ended: %v", err)
			return
		}
		m.handleMessage(conn, msg)
	}
}

// handleMessage dispatches an inbound message by type.
func (m *Manager) handleMessage(conn *websocket.Conn, msg Message) {
	switch msg.Type {
	case "hello":
		m.handleHello(conn, msg)
	case "pong":
		return
	case "tool_result":
		m.handleToolResult(msg)
	default:
		m.logger.Printf("unhandled websocket message type: %s", msg.Type)
	}
}

// handleHello records the extension's identity from its hello payload and acks it.
func (m *Manager) handleHello(conn *websocket.Conn, msg Message) {
	name, _ := msg.Payload["extensionName"].(string)
	version, _ := msg.Payload["extensionVersion"].(string)
	id, _ := msg.Payload["extensionId"].(string)

	m.mu.Lock()
	m.extensionName = name
	m.extensionVersion = version
	m.extensionID = id
	m.mu.Unlock()
	m.logger.Printf("extension hello name=%q version=%q id=%q", name, version, id)

	ack := Message{
		Type:      "hello_ack",
		RequestID: msg.RequestID,
		Payload: map[string]any{
			"version": m.version,
		},
	}
	if err := m.writeJSON(conn, ack); err != nil {
		m.logger.Printf("hello_ack failed: %v", err)
	}
}

// handleToolResult resolves the in-flight call waiting on the result's
// responseToRequestId, if any.
func (m *Manager) handleToolResult(msg Message) {
	requestID := msg.ResponseToRequestID
	if requestID == "" {
		m.logger.Printf("tool_result ignored missing_response_to_request_id")
		return
	}

	m.mu.Lock()
	resultCh := m.pending[requestID]
	delete(m.pending, requestID)
	m.mu.Unlock()
	if resultCh == nil {
		m.logger.Printf("tool_result ignored unknown_request_id=%s", requestID)
		return
	}

	if errText, ok := msg.Payload["error"].(string); ok && errText != "" {
		resultCh <- callResult{err: errors.New(errText)}
		return
	}
	resultCh <- callResult{data: msg.Payload["data"]}
}

// writeJSON serializes concurrent writes to the WebSocket, which is required by
// gorilla/websocket.
func (m *Manager) writeJSON(conn *websocket.Conn, value any) error {
	m.writeMu.Lock()
	defer m.writeMu.Unlock()
	return conn.WriteJSON(value)
}

// removePending drops a pending request ID without resolving its caller.
func (m *Manager) removePending(requestID string) {
	m.mu.Lock()
	delete(m.pending, requestID)
	m.mu.Unlock()
}

// disconnect closes conn and, if it is the active connection, clears extension
// state and fails all in-flight callers so HTTP requests do not wait out their
// timeouts.
func (m *Manager) disconnect(conn *websocket.Conn) {
	_ = conn.Close()

	m.mu.Lock()
	if m.conn != conn {
		m.mu.Unlock()
		return
	}
	m.conn = nil
	m.extensionID = ""
	m.extensionName = ""
	m.extensionVersion = ""
	pending := m.pending
	m.pending = make(map[string]chan callResult)
	m.mu.Unlock()

	// Unblock all HTTP callers; otherwise /command requests would wait until
	// their individual timeouts after the browser extension disconnects.
	for _, resultCh := range pending {
		resultCh <- callResult{err: ErrExtensionDisconnected}
	}
	m.logger.Printf("extension websocket disconnected")
}
