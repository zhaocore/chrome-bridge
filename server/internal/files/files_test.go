package files

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestNormalizeScreenshotWritesCustomPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.png")
	data, err := Normalize("screenshot", map[string]any{"path": path}, map[string]any{
		"format": "png",
		"data":   base64.StdEncoding.EncodeToString([]byte("pngdata")),
	})
	if err != nil {
		t.Fatal(err)
	}
	result := data.(map[string]any)
	if result["path"] != path {
		t.Fatalf("expected path %s, got %#v", path, result["path"])
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "pngdata" {
		t.Fatalf("unexpected file content %q", raw)
	}
}

func TestNormalizePDFRejectsTooLarge(t *testing.T) {
	old := make([]byte, MaxPDFBytes+1)
	_, err := Normalize("save_as_pdf", map[string]any{}, map[string]any{
		"data": base64.StdEncoding.EncodeToString(old),
	})
	if err == nil {
		t.Fatal("expected oversized PDF error")
	}
}

func TestNormalizePDFWritesDefaultPath(t *testing.T) {
	data, err := Normalize("save_as_pdf", map[string]any{}, map[string]any{
		"data":      base64.StdEncoding.EncodeToString([]byte("%PDF")),
		"pageTitle": "A Test Page",
	})
	if err != nil {
		t.Fatal(err)
	}
	result := data.(map[string]any)
	path, _ := result["path"].(string)
	if path == "" {
		t.Fatalf("expected path in %#v", result)
	}
	t.Cleanup(func() { _ = os.Remove(path) })
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "%PDF" {
		t.Fatalf("unexpected file content %q", raw)
	}
}
