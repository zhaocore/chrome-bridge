package session

import "testing"

func TestSessionPrepareAndUpdate(t *testing.T) {
	store := NewStore()
	store.Update("navigate", "task", map[string]any{"tabId": float64(42)})

	args := store.Prepare("click", map[string]any{"selector": "#go"}, "task")
	if args["_session"] != "task" {
		t.Fatalf("expected _session, got %#v", args)
	}
	if args["_tabId"] != 42 {
		t.Fatalf("expected _tabId=42, got %#v", args["_tabId"])
	}

	listArgs := store.Prepare("list_tabs", map[string]any{}, "task")
	tabIDs, ok := listArgs["_tabIds"].([]int)
	if !ok || len(tabIDs) != 1 || tabIDs[0] != 42 {
		t.Fatalf("expected _tabIds [42], got %#v", listArgs["_tabIds"])
	}

	navigateArgs := store.Prepare("navigate", map[string]any{"url": "https://example.com"}, "task")
	if _, ok := navigateArgs["_tabId"]; ok {
		t.Fatalf("navigate should not inject _tabId: %#v", navigateArgs)
	}
}
