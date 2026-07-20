// Package server implements the HTTP API exposed to agents. POST /command
// forwards tool calls to the extension via the bridge, GET /tools lists the
// available actions, GET /ws accepts the extension WebSocket, and
// GET /status reports daemon health.
package server

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strconv"
	"time"

	"chrome-bridge-api/internal/bridge"
	"chrome-bridge-api/internal/files"
	"chrome-bridge-api/internal/session"

	"github.com/gin-gonic/gin"
)

// DefaultPort is the port the daemon listens on when Config.Port is unset.
const DefaultPort = 10089

// Config configures a Server. Zero values are replaced with sensible defaults
// by New.
type Config struct {
	Version string
	Host    string
	Port    int
	Logger  bridge.Logger
}

// Server is the daemon's HTTP server, wiring requests to the bridge and session
// store.
type Server struct {
	cfg      Config
	started  time.Time
	bridge   *bridge.Manager
	sessions *session.Store
	router   *gin.Engine
	logger   bridge.Logger
}

// CommandRequest is the body of POST /command.
type CommandRequest struct {
	Action    string         `json:"action"`
	Args      map[string]any `json:"args"`
	Session   string         `json:"session"`
	TimeoutMS int            `json:"timeout_ms"`
}

// New builds a Server, substituting defaults for zero-value config fields and
// constructing a bridge manager and session store when none are provided.
func New(cfg Config, bridgeManager *bridge.Manager, sessions *session.Store) *Server {
	if cfg.Version == "" {
		cfg.Version = "dev"
	}
	if cfg.Host == "" {
		cfg.Host = "127.0.0.1"
	}
	if cfg.Port == 0 {
		cfg.Port = DefaultPort
	}
	if cfg.Logger == nil {
		cfg.Logger = log.Default()
	}
	if bridgeManager == nil {
		bridgeManager = bridge.NewManager(cfg.Version, cfg.Logger)
	}
	if sessions == nil {
		sessions = session.NewStore()
	}
	gin.SetMode(gin.ReleaseMode)
	s := &Server{
		cfg:      cfg,
		started:  time.Now(),
		bridge:   bridgeManager,
		sessions: sessions,
		logger:   cfg.Logger,
	}
	s.router = s.routes()
	return s
}

// Router returns the underlying HTTP handler, mainly for testing.
func (s *Server) Router() http.Handler {
	return s.router
}

// Bridge returns the bridge manager, mainly for testing.
func (s *Server) Bridge() *bridge.Manager {
	return s.bridge
}

// routes registers the API endpoints on a fresh gin engine with recovery and
// request logging middleware.
func (s *Server) routes() *gin.Engine {
	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(s.requestLogger())
	r.GET("/status", s.handleStatus)
	r.POST("/command", s.handleCommand)
	r.GET("/tools", s.handleTools)
	r.POST("/api/connections", s.handleConnection)
	r.GET("/ws", func(c *gin.Context) {
		s.bridge.ServeWS(c.Writer, c.Request)
	})
	return r
}

// handleStatus reports whether the daemon is running and whether an extension is connected.
func (s *Server) handleStatus(c *gin.Context) {
	status := s.bridge.Status()
	c.JSON(http.StatusOK, gin.H{
		"running":             true,
		"port":                s.cfg.Port,
		"version":             s.cfg.Version,
		"extension_connected": status.Connected,
		"extension_id":        status.ExtensionID,
		"extension_version":   status.ExtensionVersion,
		"uptime_seconds":      int(time.Since(s.started).Seconds()),
	})
}

// handleTools lists the tools the extension supports and their argument keys.
func (s *Server) handleTools(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"tools": toolMetas})
}

// handleConnection returns the WebSocket URL and port the extension should connect to.
func (s *Server) handleConnection(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"url":  "ws://" + s.cfg.Host + ":" + strconv.Itoa(s.cfg.Port) + "/ws",
		"port": s.cfg.Port,
	})
}

// handleCommand validates and forwards a tool call to the extension, then
// normalizes any binary result into a file path before responding.
func (s *Server) handleCommand(c *gin.Context) {
	started := time.Now()
	var req CommandRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		s.logger.Printf("command invalid_json remote=%s error=%q", c.ClientIP(), err.Error())
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Args == nil {
		req.Args = map[string]any{}
	}
	if err := ValidateTool(req.Action, req.Args); err != nil {
		s.logger.Printf("command invalid action=%q session=%q error=%q", req.Action, req.Session, err.Error())
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	timeout := 30 * time.Second
	if req.TimeoutMS > 0 {
		timeout = time.Duration(req.TimeoutMS) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), timeout)
	defer cancel()

	args := s.sessions.Prepare(req.Action, req.Args, req.Session)
	s.logger.Printf("command start action=%s session=%q timeout_ms=%d", req.Action, req.Session, int(timeout/time.Millisecond))
	data, err := s.bridge.Call(ctx, req.Action, args)
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, context.DeadlineExceeded) {
			status = http.StatusGatewayTimeout
		}
		if errors.Is(err, bridge.ErrExtensionNotConnected) {
			status = http.StatusServiceUnavailable
		}
		s.logger.Printf("command error action=%s session=%q status=%d duration_ms=%d error=%q", req.Action, req.Session, status, time.Since(started).Milliseconds(), err.Error())
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}

	data, err = files.Normalize(req.Action, req.Args, data)
	if err != nil {
		s.logger.Printf("command normalize_error action=%s session=%q duration_ms=%d error=%q", req.Action, req.Session, time.Since(started).Milliseconds(), err.Error())
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	s.sessions.Update(req.Action, req.Session, data)
	s.logger.Printf("command success action=%s session=%q duration_ms=%d", req.Action, req.Session, time.Since(started).Milliseconds())
	c.JSON(http.StatusOK, gin.H{"data": data})
}

// ListenAndServe starts the HTTP server on the configured host:port and blocks
// until it stops.
func (s *Server) ListenAndServe() error {
	s.logger.Printf("server listening host=%s port=%d version=%s", s.cfg.Host, s.cfg.Port, s.cfg.Version)
	return http.ListenAndServe(s.cfg.Host+":"+strconv.Itoa(s.cfg.Port), s.router)
}

// requestLogger returns middleware that logs one line per HTTP request.
func (s *Server) requestLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		started := time.Now()
		c.Next()
		s.logger.Printf("http method=%s path=%s status=%d duration_ms=%d client=%s",
			c.Request.Method,
			c.Request.URL.Path,
			c.Writer.Status(),
			time.Since(started).Milliseconds(),
			c.ClientIP(),
		)
	}
}
