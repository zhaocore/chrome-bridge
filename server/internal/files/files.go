// Package files normalizes extension tool results that carry binary payloads
// (screenshots, PDFs): it decodes the base64, writes it to disk, and returns a
// path so the agent never receives raw bytes.
package files

import (
	"encoding/base64"
	"errors"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// MaxPDFBytes caps the size of a decoded PDF before it is written to disk.
const MaxPDFBytes = 100 * 1024 * 1024

// Normalize converts extension-native base64 payloads into file paths returned
// to the agent. The agent never needs to receive raw screenshot or PDF bytes.
func Normalize(action string, args map[string]any, data any) (any, error) {
	switch action {
	case "screenshot":
		return normalizeScreenshot(args, data)
	case "save_as_pdf":
		return normalizePDF(args, data)
	default:
		return data, nil
	}
}

// normalizeScreenshot decodes the screenshot payload and writes it to a file,
// honoring a caller-supplied path or writing under the OS temp dir.
func normalizeScreenshot(args map[string]any, data any) (any, error) {
	m, ok := data.(map[string]any)
	if !ok {
		return data, nil
	}
	raw, ok := m["data"].(string)
	if !ok || raw == "" {
		return data, nil
	}
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("screenshot: decode base64: %w", err)
	}

	format := "png"
	if value, ok := m["format"].(string); ok && value == "jpeg" {
		format = "jpeg"
	}
	path := stringArg(args, "path")
	if path == "" {
		// Match the skill contract: caller-supplied paths are honored verbatim;
		// otherwise write under the OS temp dir.
		ext := "." + format
		if format == "jpeg" {
			ext = ".jpg"
		}
		path = filepath.Join(os.TempDir(), "chrome-bridge-screenshots", fmt.Sprintf("screenshot-%d%s", time.Now().UnixNano(), ext))
	}
	if err := writeFile(path, decoded); err != nil {
		return nil, err
	}

	return map[string]any{
		"format":    format,
		"path":      path,
		"sizeBytes": len(decoded),
		"mimeType":  mime.TypeByExtension(filepath.Ext(path)),
	}, nil
}

// normalizePDF decodes the PDF payload, enforces MaxPDFBytes, and writes it to a
// file named after the page title (or a caller-supplied path).
func normalizePDF(args map[string]any, data any) (any, error) {
	m, ok := data.(map[string]any)
	if !ok {
		return data, nil
	}
	raw, ok := m["data"].(string)
	if !ok || raw == "" {
		return data, nil
	}
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("save_as_pdf: decode base64: %w", err)
	}
	if len(decoded) > MaxPDFBytes {
		return nil, fmt.Errorf("save_as_pdf: decoded PDF exceeds 100 MB")
	}

	path := stringArg(args, "path")
	if path == "" {
		// Use the page title only as a filename hint; sanitize it before writing.
		title, _ := m["pageTitle"].(string)
		if title == "" {
			title = "page"
		}
		path = filepath.Join(os.TempDir(), "chrome-bridge-pdfs", fmt.Sprintf("%s-%d.pdf", sanitizeFilePart(title), time.Now().UnixNano()))
	}
	if err := writeFile(path, decoded); err != nil {
		return nil, err
	}

	return map[string]any{
		"path":      path,
		"sizeBytes": len(decoded),
		"mimeType":  "application/pdf",
		"pageTitle": m["pageTitle"],
	}, nil
}

// writeFile creates the parent directory and writes data to path.
func writeFile(path string, data []byte) error {
	if path == "" {
		return errors.New("path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// stringArg returns args[key] as a string, or "" if absent or non-string.
func stringArg(args map[string]any, key string) string {
	value, _ := args[key].(string)
	return value
}

// unsafeFileChars matches any character that is unsafe in a filename.
var unsafeFileChars = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

// sanitizeFilePart collapses unsafe characters to dashes and trims the result
// for use as a filename hint.
func sanitizeFilePart(value string) string {
	value = strings.Trim(unsafeFileChars.ReplaceAllString(value, "-"), ".-")
	if value == "" {
		return "page"
	}
	if len(value) > 80 {
		return value[:80]
	}
	return value
}
