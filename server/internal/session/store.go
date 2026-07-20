// Package session tracks the tab IDs the daemon has learned for a named agent
// session so subsequent tool calls target the right tab without the agent
// re-stating it. The extension owns the browser; this package only remembers
// the tab IDs returned by prior navigate/find_tab calls.
package session

import "sync"

// Store maps session names to their tab state. It is safe for concurrent use.
type Store struct {
	mu       sync.Mutex
	sessions map[string]*State
}

// State is the per-session tab tracking data injected into tool calls.
type State struct {
	TabID  int
	TabIDs []int
}

// NewStore returns an empty session store.
func NewStore() *Store {
	return &Store{sessions: make(map[string]*State)}
}

// Prepare clones args and injects the session name and any learned tab IDs
// relevant to action. With no session name it returns args unchanged.
func (s *Store) Prepare(action string, args map[string]any, name string) map[string]any {
	prepared := make(map[string]any, len(args)+2)
	for key, value := range args {
		prepared[key] = value
	}
	if name == "" {
		return prepared
	}

	prepared["_session"] = name
	s.mu.Lock()
	state := s.sessions[name]
	if state != nil {
		// The extension owns browser state. The daemon only injects the tab IDs
		// it learned from prior navigate/find_tab calls in the same session.
		switch action {
		case "list_tabs", "close_session":
			if len(state.TabIDs) > 0 {
				prepared["_tabIds"] = append([]int(nil), state.TabIDs...)
			}
		case "navigate", "find_tab":
		default:
			if state.TabID != 0 {
				prepared["_tabId"] = state.TabID
			}
		}
	}
	s.mu.Unlock()
	return prepared
}

// Update records the tab ID returned by navigate or find_tab into the named
// session. Other actions are ignored.
func (s *Store) Update(action, name string, data any) {
	if name == "" || (action != "navigate" && action != "find_tab") {
		return
	}
	tabID, ok := extractTabID(data)
	if !ok || tabID == 0 {
		return
	}

	// Only navigation-like tools establish a session target tab.
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.sessions[name]
	if state == nil {
		state = &State{}
		s.sessions[name] = state
	}
	state.TabID = tabID
	for _, existing := range state.TabIDs {
		if existing == tabID {
			return
		}
	}
	state.TabIDs = append(state.TabIDs, tabID)
}

// Snapshot returns a copy of the named session's state, or the zero value if
// the session has no recorded state.
func (s *Store) Snapshot(name string) State {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.sessions[name]
	if state == nil {
		return State{}
	}
	return State{TabID: state.TabID, TabIDs: append([]int(nil), state.TabIDs...)}
}

// extractTabID pulls the tabId field from a tool result payload, tolerating the
// numeric widths JSON unmarshaling may produce.
func extractTabID(data any) (int, bool) {
	m, ok := data.(map[string]any)
	if !ok {
		return 0, false
	}
	switch value := m["tabId"].(type) {
	case int:
		return value, true
	case int64:
		return int(value), true
	case float64:
		return int(value), true
	case float32:
		return int(value), true
	default:
		return 0, false
	}
}
