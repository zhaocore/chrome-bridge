// Package runtime handles the daemon's on-disk lifecycle: install paths, PID
// files, log rotation, background start/stop, status probing, log tailing, and
// skill installation. It is used by the CLI subcommands in cmd/chrome-bridge.
package runtime

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Paths holds the daemon's filesystem locations under ~/.chrome-bridge.
type Paths struct {
	Home       string
	InstallDir string
	BinDir     string
	PIDFile    string
	LogFile    string
	PrevLog    string
}

// Status is the daemon health report returned to the CLI status subcommand and
// HTTP /status callers.
type Status struct {
	Running            bool   `json:"running"`
	Port               int    `json:"port"`
	Version            string `json:"version"`
	ExtensionConnected bool   `json:"extension_connected"`
	ExtensionID        string `json:"extension_id"`
	ExtensionVersion   string `json:"extension_version"`
	UptimeSeconds      int    `json:"uptime_seconds"`
}

// LogOptions configures the logs subcommand output.
type LogOptions struct {
	Lines    int
	Follow   bool
	Previous bool
}

// DefaultPaths returns the standard install layout rooted at ~/.chrome-bridge.
func DefaultPaths() Paths {
	home, _ := os.UserHomeDir()
	install := filepath.Join(home, ".chrome-bridge")
	return Paths{
		Home:       home,
		InstallDir: install,
		BinDir:     filepath.Join(install, "bin"),
		PIDFile:    filepath.Join(install, "chrome-bridge.pid"),
		LogFile:    filepath.Join(install, "daemon.log"),
		PrevLog:    filepath.Join(install, "daemon.prev.log"),
	}
}

// EnsureDirs creates the install and bin directories if they are missing.
func EnsureDirs(paths Paths) error {
	if err := os.MkdirAll(paths.InstallDir, 0o755); err != nil {
		return err
	}
	return os.MkdirAll(paths.BinDir, 0o755)
}

// WritePID persists pid to the PID file, creating directories as needed.
func WritePID(paths Paths, pid int) error {
	if err := EnsureDirs(paths); err != nil {
		return err
	}
	return os.WriteFile(paths.PIDFile, []byte(strconv.Itoa(pid)), 0o644)
}

// ReadPID reads and parses the PID from the PID file.
func ReadPID(paths Paths) (int, error) {
	raw, err := os.ReadFile(paths.PIDFile)
	if err != nil {
		return 0, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		return 0, err
	}
	return pid, nil
}

// RemovePID deletes the PID file, ignoring errors if it is absent.
func RemovePID(paths Paths) {
	_ = os.Remove(paths.PIDFile)
}

// BaseURL returns the http://host:port base URL for the daemon, defaulting host
// to 127.0.0.1 when empty.
func BaseURL(host string, port int) string {
	if host == "" {
		host = "127.0.0.1"
	}
	return fmt.Sprintf("http://%s:%d", host, port)
}

// Start launches the daemon as a detached background process, rotating the
// previous log file first. It is a no-op if a daemon is already running on port.
func Start(paths Paths, executable string, port int) error {
	if err := EnsureDirs(paths); err != nil {
		return err
	}
	if status, err := FetchStatus(BaseURL("127.0.0.1", port), 500*time.Millisecond, port); err == nil && status.Running {
		return nil
	}
	if _, err := os.Stat(paths.LogFile); err == nil {
		_ = os.Rename(paths.LogFile, paths.PrevLog)
	}
	logFile, err := os.OpenFile(paths.LogFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer logFile.Close()

	cmd := exec.Command(executable, "serve")
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.Env = append(os.Environ(), "CHROME_BRIDGE_DAEMON=1")
	if err := cmd.Start(); err != nil {
		return err
	}
	if err := WritePID(paths, cmd.Process.Pid); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// Stop sends SIGTERM to the daemon named by the PID file and removes the PID file.
func Stop(paths Paths) error {
	pid, err := ReadPID(paths)
	if err != nil {
		return err
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	if err := process.Signal(syscall.SIGTERM); err != nil {
		return err
	}
	RemovePID(paths)
	return nil
}

// FetchStatus queries a daemon's /status endpoint. On failure it returns a
// not-running Status carrying fallbackPort.
func FetchStatus(baseURL string, timeout time.Duration, fallbackPort int) (Status, error) {
	client := &http.Client{Timeout: timeout}
	resp, err := client.Get(strings.TrimRight(baseURL, "/") + "/status")
	if err != nil {
		return Status{Running: false, Port: fallbackPort}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Status{Running: false, Port: fallbackPort}, fmt.Errorf("status returned HTTP %d", resp.StatusCode)
	}
	var status Status
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		return Status{Running: false, Port: fallbackPort}, err
	}
	status.Running = true
	return status, nil
}

// ParseLogOptions parses the logs subcommand flags: -n <lines>, -f, --prev.
func ParseLogOptions(args []string) (LogOptions, error) {
	opts := LogOptions{Lines: 100}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-n":
			if i+1 >= len(args) {
				return opts, errors.New("logs: -n requires a number")
			}
			n, err := strconv.Atoi(args[i+1])
			if err != nil || n < 1 {
				return opts, errors.New("logs: -n must be a positive integer")
			}
			opts.Lines = n
			i++
		case "-f":
			opts.Follow = true
		case "--prev":
			opts.Previous = true
		default:
			return opts, fmt.Errorf("logs: unknown option %s", args[i])
		}
	}
	return opts, nil
}

// PrintLogs writes the last opts.Lines log lines to out, optionally following
// the file for new entries.
func PrintLogs(paths Paths, opts LogOptions, out io.Writer) error {
	path := paths.LogFile
	if opts.Previous {
		path = paths.PrevLog
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	start := 0
	if len(lines) > opts.Lines {
		start = len(lines) - opts.Lines
	}
	for _, line := range lines[start:] {
		if line != "" {
			fmt.Fprintln(out, line)
		}
	}
	if opts.Follow {
		return followFile(path, out)
	}
	return nil
}

// followFile tails path to out, polling every 500ms for new bytes.
func followFile(path string, out io.Writer) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	if _, err := file.Seek(0, io.SeekEnd); err != nil {
		return err
	}
	buf := make([]byte, 4096)
	for {
		n, err := file.Read(buf)
		if n > 0 {
			if _, writeErr := out.Write(buf[:n]); writeErr != nil {
				return writeErr
			}
		}
		if err == io.EOF {
			time.Sleep(500 * time.Millisecond)
			continue
		}
		if err != nil {
			return err
		}
	}
}

// skillRepoURL is the GitHub archive URL for the chrome-bridge-skill repo.
const skillRepoURL = "https://github.com/zhaocore/chrome-bridge-skill/archive/refs/heads/master.zip"

// DownloadAndInstallSkill downloads the chrome-bridge-skill repo as a zip
// archive from GitHub, extracts it to a temporary directory, and copies the
// contents into the daemon's skill directory. The temporary directory is
// removed when finished.
func DownloadAndInstallSkill(paths Paths) error {
	tmpDir, err := os.MkdirTemp("", "chrome-bridge-skill-*")
	if err != nil {
		return fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	resp, err := http.Get(skillRepoURL)
	if err != nil {
		return fmt.Errorf("download skill archive: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download skill archive: HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read skill archive: %w", err)
	}

	zipReader, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		return fmt.Errorf("open skill archive: %w", err)
	}

	for _, f := range zipReader.File {
		if err := extractZipFile(f, tmpDir); err != nil {
			return fmt.Errorf("extract %s: %w", f.Name, err)
		}
	}

	// GitHub archives extract to <repo>-<branch>/ e.g. chrome-bridge-skill-master/
	entries, err := os.ReadDir(tmpDir)
	if err != nil {
		return fmt.Errorf("read extracted dir: %w", err)
	}
	if len(entries) == 0 {
		return fmt.Errorf("extracted archive is empty")
	}
	src := filepath.Join(tmpDir, entries[0].Name())
	if !entries[0].IsDir() {
		return fmt.Errorf("expected directory in archive root, got file %s", entries[0].Name())
	}

	dst := filepath.Join(paths.InstallDir, "skills", "chrome-bridge")
	_ = os.RemoveAll(dst)
	if err := copyDir(src, dst); err != nil {
		return fmt.Errorf("copy skill files: %w", err)
	}

	// Create symlinks in discovered agent skill directories so multiple
	// agents share the same skill installation.
	linked := linkSkillToAgents(dst)
	if len(linked) > 0 {
		log.Printf("skill linked to %d agent(s): %s", len(linked), strings.Join(linked, ", "))
	}
	return nil
}

// agentSkillDirs lists common agent skill directory patterns relative to the
// user's home directory. Each entry is a glob pattern; directories that exist
// are used as symlink targets.
var agentSkillDirs = []string{
	".claude/skills",
	".agents/skills",
	".codex/skills",
	".cursor/skills",
	".cline/skills",
	".continue/skills",
	".windsurf/skills",
	".roo/skills",
	".vscode/skills",
	".openclaw/skills",
	".hermes/skills",
}

// linkSkillToAgents scans for existing agent skill directories under the
// user's home and creates a symlink named "chrome-bridge" in each one pointing
// to skillDir. Returns the list of agent paths where a symlink was created or
// already existed.
func linkSkillToAgents(skillDir string) []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	var linked []string
	for _, rel := range agentSkillDirs {
		agentDir := filepath.Join(home, rel)
		if info, err := os.Stat(agentDir); err != nil || !info.IsDir() {
			continue
		}
		linkPath := filepath.Join(agentDir, "chrome-bridge")
		if err := symlinkSkill(skillDir, linkPath); err != nil {
			log.Printf("warning: could not link skill to %s: %v", agentDir, err)
			continue
		}
		linked = append(linked, rel)
	}
	return linked
}

// symlinkSkill creates a symlink at linkPath pointing to target, replacing any
// existing symlink or directory at that path. If linkPath already points to
// target, it is a no-op.
func symlinkSkill(target, linkPath string) error {
	// Check if a valid symlink already exists.
	if existing, err := os.Readlink(linkPath); err == nil && existing == target {
		return nil
	}
	// Remove existing file/symlink/directory at linkPath.
	_ = os.RemoveAll(linkPath)
	return os.Symlink(target, linkPath)
}

// extractZipFile extracts a single zip entry to destDir, preserving paths.
func extractZipFile(f *zip.File, destDir string) error {
	target := filepath.Join(destDir, f.Name)
	if !strings.HasPrefix(filepath.Clean(target), filepath.Clean(destDir)+string(os.PathSeparator)) {
		return fmt.Errorf("zip path escapes destination: %s", f.Name)
	}
	if f.FileInfo().IsDir() {
		return os.MkdirAll(target, 0o755)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, rc)
	return err
}

// InstallSkill copies chrome-bridge-skill from repoRoot into the daemon's skill
// directory, replacing any prior copy, then links it to discovered agent skill
// directories.
func InstallSkill(repoRoot string, paths Paths) error {
	src := filepath.Join(repoRoot, "chrome-bridge-skill")
	if _, err := os.Stat(src); err != nil {
		return err
	}
	dst := filepath.Join(paths.InstallDir, "skills", "chrome-bridge")
	_ = os.RemoveAll(dst)
	if err := copyDir(src, dst); err != nil {
		return err
	}
	linked := linkSkillToAgents(dst)
	if len(linked) > 0 {
		log.Printf("skill linked to %d agent(s): %s", len(linked), strings.Join(linked, ", "))
	}
	return nil
}

// copyDir recursively copies the src directory tree to dst.
func copyDir(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
}
