package main

import (
	"crypto/subtle"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/bcrypt"

	"lanparty/internal/config"
	"lanparty/internal/httpserver"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	if len(os.Args) > 1 && os.Args[1] == "passwd" {
		passwdCmd(os.Args[2:])
		return
	}

	var (
		addr     = flag.String("addr", "0.0.0.0:3923", "listen address")
		root     = flag.String("root", "", "share root (required if -config is not set)")
		stateDir = flag.String("state", "", "state dir for uploads/dedup/thumbs (default: <root>/.lanparty)")
		cfgPath  = flag.String("config", "", "path to config json (optional)")
	)
	flag.Parse()

	var cfg config.Config
	if *cfgPath != "" {
		b, err := os.ReadFile(*cfgPath)
		if err != nil {
			log.Fatalf("read config: %v", err)
		}
		if err := json.Unmarshal(b, &cfg); err != nil {
			log.Fatalf("parse config: %v", err)
		}
	} else {
		if strings.TrimSpace(*root) == "" {
			log.Fatalf("missing -root (or provide -config)")
		}
		cfg.Root = *root
		cfg.StateDir = *stateDir
	}

	if cfg.Root == "" {
		log.Fatalf("config: root is required")
	}
	absRoot, err := filepath.Abs(cfg.Root)
	if err != nil {
		log.Fatalf("abs root: %v", err)
	}
	cfg.Root = absRoot
	if cfg.StateDir == "" {
		cfg.StateDir = filepath.Join(cfg.Root, ".lanparty")
	}
	if err := os.MkdirAll(cfg.StateDir, 0o755); err != nil {
		log.Fatalf("mkdir state: %v", err)
	}

	srv, err := httpserver.New(httpserver.Options{
		Config: cfg,
	})
	if err != nil {
		log.Fatalf("server init: %v", err)
	}

	log.Printf("lanparty listening on http://%s (root=%s)", *addr, cfg.Root)
	log.Printf("webdav endpoint: http://%s/dav/  (use BasicAuth if configured)", *addr)
	if err := http.ListenAndServe(*addr, withHeaders(srv.Handler())); err != nil {
		log.Fatalf("listen: %v", err)
	}
}

func passwdCmd(args []string) {
	fs := flag.NewFlagSet("passwd", flag.ExitOnError)
	var (
		password = fs.String("p", "", "password (required)")
		cost     = fs.Int("cost", bcrypt.DefaultCost, "bcrypt cost")
	)
	_ = fs.Parse(args)
	if *password == "" {
		fmt.Fprintln(os.Stderr, "usage: lanparty passwd -p <password>")
		os.Exit(2)
	}
	if *cost < bcrypt.MinCost || *cost > bcrypt.MaxCost {
		fmt.Fprintf(os.Stderr, "invalid cost %d (min=%d max=%d)\n", *cost, bcrypt.MinCost, bcrypt.MaxCost)
		os.Exit(2)
	}
	h, err := bcrypt.GenerateFromPassword([]byte(*password), *cost)
	if err != nil {
		log.Fatalf("bcrypt: %v", err)
	}
	fmt.Println(string(h))
}

func withHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Basic hardening / UX.
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")

		// Cheap cache-bust for the UI (embedded assets are versioned by build).
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=3600")
		} else {
			w.Header().Set("Cache-Control", "no-store")
		}

		// Mitigate basic timing leaks for unauth errors.
		if r.Header.Get("Authorization") == "" && r.URL.Path != "/healthz" {
			_ = subtle.ConstantTimeByteEq(1, 1)
		}

		next.ServeHTTP(w, r)
	})
}


