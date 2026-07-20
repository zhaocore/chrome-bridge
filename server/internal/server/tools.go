package server

import "fmt"

// ToolMeta describes a tool's required and optional argument keys, surfaced via
// GET /tools and used to validate POST /command requests.
type ToolMeta struct {
	Name     string   `json:"name"`
	Required []string `json:"required,omitempty"`
	Optional []string `json:"optional,omitempty"`
}

// toolMetas is the registry of tools the extension supports. It is the source
// of truth for both the /tools listing and argument validation.
var toolMetas = []ToolMeta{
	{Name: "navigate", Required: []string{"url"}, Optional: []string{"newTab", "new_tab", "group_title"}},
	{Name: "find_tab", Required: []string{"url"}, Optional: []string{"active"}},
	{Name: "snapshot"},
	{Name: "click", Required: []string{"selector"}},
	{Name: "fill", Required: []string{"selector", "value"}},
	{Name: "evaluate", Required: []string{"code"}},
	{Name: "network", Required: []string{"cmd"}, Optional: []string{"filter", "requestId"}},
	{Name: "upload", Required: []string{"selector", "files"}},
	{Name: "screenshot", Optional: []string{"format", "quality", "selector", "path"}},
	{Name: "save_as_pdf", Optional: []string{"paper_format", "landscape", "scale", "print_background", "path"}},
	{Name: "list_tabs"},
	{Name: "close_tab"},
	{Name: "close_session"},
	{Name: "mouse_click", Required: []string{"selector"}},
	{Name: "cdp", Required: []string{"method"}, Optional: []string{"params"}},
	{Name: "key_type", Required: []string{"text"}},
	{Name: "send_keys", Required: []string{"keys"}, Optional: []string{"repeat"}},
}

// toolsByName indexes toolMetas by tool name for O(1) validation lookups.
var toolsByName = func() map[string]ToolMeta {
	out := make(map[string]ToolMeta, len(toolMetas))
	for _, tool := range toolMetas {
		out[tool.Name] = tool
	}
	return out
}()

// ValidateTool checks that args contains all required keys for the named tool
// and enforces the network action's per-cmd rules. It returns an error naming
// the first missing or invalid argument.
func ValidateTool(name string, args map[string]any) error {
	meta, ok := toolsByName[name]
	if !ok {
		return fmt.Errorf("unknown action: %s", name)
	}
	for _, key := range meta.Required {
		value, exists := args[key]
		if !exists || value == nil || value == "" {
			return fmt.Errorf("%s: %s is required", name, key)
		}
	}
	if name == "network" {
		cmd, _ := args["cmd"].(string)
		switch cmd {
		case "start", "stop", "list":
			return nil
		case "detail":
			if args["requestId"] == nil || args["requestId"] == "" {
				return fmt.Errorf("network: requestId is required for detail")
			}
		default:
			return fmt.Errorf("network: unknown cmd %q", cmd)
		}
	}
	return nil
}
