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

var (
	version = "dev"
	commit  = ""
	builtAt = ""
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	if len(os.Args) > 1 && os.Args[1] == "passwd" {
		passwdCmd(os.Args[2:])
		return
	}

	var (
		addr      = flag.String("addr", "0.0.0.0:3923", "listen address")
		root      = flag.String("root", "", "share root (required if -config is not set)")
		stateDir  = flag.String("state", "", "state dir for uploads/dedup/thumbs (default: <root>/.lanparty)")
		cfgPath   = flag.String("config", "", "path to config json (optional)")
		portable  = flag.Bool("portable", false, "store all state in ./ .lanparty-state instead of inside share roots (useful for portable/readonly shares)")
		followSym = flag.Bool("follow-symlinks", false, "allow following symlinks/junctions (only when resolved target stays inside the share root)")
		showVer   = flag.Bool("version", false, "print version and exit")
	)
	flag.Parse()

	if *showVer {
		fmt.Printf("lanparty %s\n", version)
		if commit != "" {
			fmt.Printf("commit: %s\n", commit)
		}
		if builtAt != "" {
			fmt.Printf("built:  %s\n", builtAt)
		}
		return
	}

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
		if len(cfg.Shares) == 0 {
			log.Fatalf("config: root is required (or define shares)")
		}
	}

	if *followSym {
		cfg.FollowSymlinks = true
		for name, sh := range cfg.Shares {
			if sh.FollowSymlinks == nil || !*sh.FollowSymlinks {
				val := true
				sh.FollowSymlinks = &val
				cfg.Shares[name] = sh
			}
		}
	}
	// Portable state: keep runtime state out of share roots.
	var portableBase string
	if *portable {
		cwd, _ := os.Getwd()
		portableBase = filepath.Join(cwd, ".lanparty-state")
	}

	if cfg.Root != "" {
		absRoot, err := filepath.Abs(cfg.Root)
		if err != nil {
			log.Fatalf("abs root: %v", err)
		}
		cfg.Root = absRoot
		if cfg.StateDir == "" {
			if portableBase != "" {
				cfg.StateDir = filepath.Join(portableBase, "default")
			} else {
				cfg.StateDir = filepath.Join(cfg.Root, ".lanparty")
			}
		}
		if err := os.MkdirAll(cfg.StateDir, 0o755); err != nil {
			log.Fatalf("mkdir state: %v", err)
		}
	}
	// Normalize shares.
	for name, sh := range cfg.Shares {
		if strings.TrimSpace(name) == "" {
			log.Fatalf("config: share name cannot be empty")
		}
		if strings.TrimSpace(sh.Root) == "" {
			log.Fatalf("config: share %q missing root", name)
		}
		absRoot, err := filepath.Abs(sh.Root)
		if err != nil {
			log.Fatalf("abs share root (%s): %v", name, err)
		}
		sh.Root = absRoot
		if sh.StateDir == "" {
			if portableBase != "" {
				sh.StateDir = filepath.Join(portableBase, "share-"+name)
			} else {
				sh.StateDir = filepath.Join(sh.Root, ".lanparty")
			}
		}
		if err := os.MkdirAll(sh.StateDir, 0o755); err != nil {
			log.Fatalf("mkdir share state (%s): %v", name, err)
		}
		cfg.Shares[name] = sh
	}

	srv, err := httpserver.New(httpserver.Options{
		Config: cfg,
		ConfigPath: *cfgPath,
	})
	if err != nil {
		log.Fatalf("server init: %v", err)
	}

	if cfg.Root != "" {
		log.Printf("lanparty listening on http://%s (root=%s)", *addr, cfg.Root)
	} else {
		log.Printf("lanparty listening on http://%s (root=<none>; shares=%d)", *addr, len(cfg.Shares))
	}
	if portableBase != "" {
		log.Printf("portable state dir: %s", portableBase)
	}
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


