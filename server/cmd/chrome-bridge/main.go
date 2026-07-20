// Command chrome-bridge is the local daemon CLI. It launches and supervises the
// HTTP/WebSocket server that bridges agents to the Chrome extension, and exposes
// subcommands for start, stop, restart, status, logs, and install-skill.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"chrome-bridge-api/internal/runtime"
	"chrome-bridge-api/internal/server"
)

// version is the daemon version reported via /status. It is overridden at build
// time with: go build -ldflags "-X main.version=1.2.3" ./cmd/chrome-bridge
const version = "dev"

// defaultPort is intentionally a string so release builds can override it with:
// go build -ldflags "-X main.defaultPort=10090" ./cmd/chrome-bridge
var defaultPort = "10089"

// main is the CLI entry point. It dispatches the subcommand in os.Args[1].
func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	paths := runtime.DefaultPaths()
	cmd := os.Args[1]
	port, err := parsePort(defaultPort)
	if err != nil {
		fatal(err)
	}

	switch cmd {
	case "serve":
		if err := serve(paths, port); err != nil {
			log.Fatal(err)
		}
	case "start":
		exe, err := os.Executable()
		if err != nil {
			fatal(err)
		}
		if err := runtime.Start(paths, exe, port); err != nil {
			fatal(err)
		}
		fmt.Println("daemon started")
	case "stop":
		if err := runtime.Stop(paths); err != nil {
			fatal(err)
		}
		fmt.Println("daemon stopped")
	case "restart":
		_ = runtime.Stop(paths)
		exe, err := os.Executable()
		if err != nil {
			fatal(err)
		}
		if err := runtime.Start(paths, exe, port); err != nil {
			fatal(err)
		}
		fmt.Println("daemon restarted")
	case "status":
		status, err := runtime.FetchStatus(runtime.BaseURL("127.0.0.1", port), time.Second, port)
		if err != nil {
			status = runtime.Status{Running: false, Port: port}
		}
		_ = json.NewEncoder(os.Stdout).Encode(status)
	case "logs":
		opts, err := runtime.ParseLogOptions(os.Args[2:])
		if err != nil {
			fatal(err)
		}
		if err := runtime.PrintLogs(paths, opts, os.Stdout); err != nil {
			fatal(err)
		}
	case "install-skill":
		if err := runtime.DownloadAndInstallSkill(paths); err != nil {
			fatal(err)
		}
		fmt.Println("skill installed")
	default:
		usage()
		os.Exit(2)
	}
}

// serve runs the HTTP server in the foreground, writing a PID file and
// blocking until SIGINT/SIGTERM is received or the server errors out.
func serve(paths runtime.Paths, port int) error {
	if err := runtime.WritePID(paths, os.Getpid()); err != nil {
		return err
	}
	defer runtime.RemovePID(paths)

	log.Printf("starting chrome-bridge version=%s port=%d", version, port)
	s := server.New(server.Config{Version: version, Port: port}, nil, nil)
	errCh := make(chan error, 1)
	go func() {
		errCh <- s.ListenAndServe()
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	select {
	case sig := <-stop:
		log.Printf("received %s, exiting", sig)
		return nil
	case err := <-errCh:
		return err
	}
}

// parsePort converts a port string to an int, validating the 1–65535 range.
func parsePort(value string) (int, error) {
	port, err := strconv.Atoi(value)
	if err != nil || port < 1 || port > 65535 {
		return 0, fmt.Errorf("invalid defaultPort %q: must be 1-65535", value)
	}
	return port, nil
}

// usage prints the CLI subcommand list to stderr.
func usage() {
	fmt.Fprintln(os.Stderr, "usage: chrome-bridge <start|stop|restart|status|logs|install-skill|serve>")
}

// fatal prints err to stderr and exits with code 1.
func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
