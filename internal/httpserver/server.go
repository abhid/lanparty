package httpserver

import (
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/rand"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
	"golang.org/x/net/webdav"

	"lanparty/internal/auth"
	"lanparty/internal/config"
	"lanparty/internal/dedup"
	"lanparty/internal/fsutil"
	"lanparty/internal/upload"
)

type Options struct {
	Config       config.Config
	ConfigPath   string
	DisableAdmin bool
}

type ctxKey int

const shareKey ctxKey = 1

func shareFromContext(ctx context.Context) string {
	v := ctx.Value(shareKey)
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

type Server struct {
	cfg          config.Config
	cfgMu        sync.RWMutex
	cfgPath      string
	disableAdmin bool

	mu       sync.Mutex
	dedup    map[string]*dedup.Store
	uploads  map[string]*upload.Manager
	davLocks map[string]webdav.LockSystem

	thumbMu       sync.Mutex
	thumbInflight map[string]*thumbCall
	thumbSem      chan struct{}

	webFS fs.FS
}

type thumbCall struct {
	done chan struct{}
	b    []byte
	err  error
}

type gzipRW struct {
	http.ResponseWriter
	gw *gzip.Writer
}

func (g gzipRW) Write(p []byte) (int, error) {
	return g.gw.Write(p)
}

func gzipIfAccepted(next http.Handler, should func(*http.Request) bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !should(r) || !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Vary", "Accept-Encoding")
		w.Header().Del("Content-Length")
		gw, _ := gzip.NewWriterLevel(w, gzip.BestSpeed)
		defer gw.Close()
		next.ServeHTTP(gzipRW{ResponseWriter: w, gw: gw}, r)
	})
}

func parseBasicAuthHeader(v string) (user, pass string, ok bool) {
	const prefix = "Basic "
	if !strings.HasPrefix(v, prefix) {
		return "", "", false
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(strings.TrimPrefix(v, prefix)))
	if err != nil {
		return "", "", false
	}
	s := string(raw)
	i := strings.IndexByte(s, ':')
	if i < 0 {
		return "", "", false
	}
	u := s[:i]
	p := s[i+1:]
	if u == "" {
		return "", "", false
	}
	if strings.Contains(u, "\x00") || strings.Contains(p, "\x00") {
		return "", "", false
	}
	return u, p, true
}

// safeWebDAVFS enforces lanparty's path + symlink policy for WebDAV.
// webdav.Dir only enforces lexical containment; it may follow symlinks to escape the root.
type safeWebDAVFS struct {
	cfg config.Config
}

func (s safeWebDAVFS) resolve(name string) (string, error) {
	// webdav passes paths like "/foo/bar" (relative to the FS root).
	rel := fsutil.CleanRelPath(strings.TrimPrefix(name, "/"))
	return fsutil.ResolveWithinRoot(s.cfg.Root, rel, s.cfg.FollowSymlinks)
}

func (s safeWebDAVFS) Mkdir(ctx context.Context, name string, perm os.FileMode) error {
	abs, err := s.resolve(name)
	if err != nil {
		return err
	}
	return os.Mkdir(abs, perm)
}

func (s safeWebDAVFS) OpenFile(ctx context.Context, name string, flag int, perm os.FileMode) (webdav.File, error) {
	abs, err := s.resolve(name)
	if err != nil {
		return nil, err
	}
	return os.OpenFile(abs, flag, perm)
}

func (s safeWebDAVFS) RemoveAll(ctx context.Context, name string) error {
	abs, err := s.resolve(name)
	if err != nil {
		return err
	}
	return os.RemoveAll(abs)
}

func (s safeWebDAVFS) Rename(ctx context.Context, oldName, newName string) error {
	oldAbs, err := s.resolve(oldName)
	if err != nil {
		return err
	}
	newAbs, err := s.resolve(newName)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(newAbs), 0o755); err != nil {
		return err
	}
	return os.Rename(oldAbs, newAbs)
}

func (s safeWebDAVFS) Stat(ctx context.Context, name string) (os.FileInfo, error) {
	abs, err := s.resolve(name)
	if err != nil {
		return nil, err
	}
	return os.Stat(abs)
}

//go:embed web/index.html web/admin.html web/unauthorized.html web/assets/* web/assets/fonts/*
var embeddedWeb embed.FS

func New(opts Options) (*Server, error) {
	sub, err := fs.Sub(embeddedWeb, "web")
	if err != nil {
		return nil, err
	}
	return &Server{
		cfg:          opts.Config,
		cfgPath:      opts.ConfigPath,
		disableAdmin: opts.DisableAdmin,
		dedup:        map[string]*dedup.Store{},
		uploads:      map[string]*upload.Manager{},
		davLocks:     map[string]webdav.LockSystem{},
		webFS:        sub,
	}, nil
}

func (s *Server) cfgForReq(r *http.Request) config.Config {
	s.cfgMu.RLock()
	cfg := s.cfg
	s.cfgMu.RUnlock()
	name := shareFromContext(r.Context())
	if name == "" {
		return cfg
	}
	sh, ok := cfg.Shares[name]
	if !ok {
		return cfg
	}
	// share root/state
	cfg.Root = sh.Root
	if sh.StateDir != "" {
		cfg.StateDir = sh.StateDir
	} else if cfg.Root != "" {
		cfg.StateDir = filepath.Join(cfg.Root, ".lanparty")
	}
	// share ACL override (optional)
	if len(sh.ACLs) > 0 {
		cfg.ACLs = sh.ACLs
	}
	if sh.FollowSymlinks != nil {
		cfg.FollowSymlinks = *sh.FollowSymlinks
	}
	return cfg
}

func (s *Server) sharePrefix(r *http.Request) string {
	if sh := shareFromContext(r.Context()); sh != "" {
		return "/s/" + sh
	}
	return ""
}

func (s *Server) withSharePrefix(r *http.Request, p string) string {
	return s.sharePrefix(r) + p
}

func (s *Server) shareDeps(r *http.Request) (*dedup.Store, *upload.Manager, error) {
	cfg := s.cfgForReq(r)
	name := shareFromContext(r.Context())
	// default share uses empty name key
	key := name

	s.mu.Lock()
	defer s.mu.Unlock()

	if st, ok := s.dedup[key]; ok {
		if up, ok2 := s.uploads[key]; ok2 {
			return st, up, nil
		}
	}

	store, err := dedup.New(cfg.StateDir)
	if err != nil {
		return nil, nil, err
	}
	up, err := upload.New(cfg.Root, cfg.StateDir, store, cfg.FollowSymlinks)
	if err != nil {
		return nil, nil, err
	}
	s.dedup[key] = store
	s.uploads[key] = up
	return store, up, nil
}

func (s *Server) davLockForReq(r *http.Request) webdav.LockSystem {
	name := shareFromContext(r.Context())
	key := name
	s.mu.Lock()
	defer s.mu.Unlock()
	if ls, ok := s.davLocks[key]; ok {
		return ls
	}
	ls := webdav.NewMemLS()
	s.davLocks[key] = ls
	return ls
}

func (s *Server) Handler() http.Handler {
	inner := http.NewServeMux()
	mux := http.NewServeMux()

	// health
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, "ok\n")
	})

	// Login helper for browsers (triggers BasicAuth prompt).
	inner.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		if !auth.HasAuth(s.cfg) {
			http.Redirect(w, r, "/", http.StatusFound)
			return
		}
		if auth.UserFromContext(r.Context()) != "" {
			http.Redirect(w, r, "/", http.StatusFound)
			return
		}
		s.authChallenge(w)
	})

	// WebDAV
	inner.Handle("/dav/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cfg := s.cfgForReq(r)
		dav := &webdav.Handler{
			Prefix:     "/dav",
			FileSystem: safeWebDAVFS{cfg: cfg},
			LockSystem: s.davLockForReq(r),
		}
		// Path-aware ACL enforcement for WebDAV.
		clean := s.davPathToClean(r.URL.Path)
		if ok, err := s.allowed(r, auth.PermRead, clean); err != nil || !ok {
			if s.shouldChallenge(r) {
				s.authChallenge(w)
			} else {
				http.Error(w, "forbidden", http.StatusForbidden)
			}
			return
		}
		switch r.Method {
		case "GET", "HEAD", "OPTIONS", "PROPFIND":
			// read ok
		default:
			if ok, err := s.allowed(r, auth.PermWrite, clean); err != nil || !ok {
				if s.shouldChallenge(r) {
					s.authChallenge(w)
				} else {
					http.Error(w, "forbidden", http.StatusForbidden)
				}
				return
			}
		}
		dav.ServeHTTP(w, r)
	}))

	// static assets
	assets, _ := fs.Sub(s.webFS, "assets")
	assetFS := http.StripPrefix("/assets/", http.FileServer(http.FS(assets)))
	mux.Handle("/assets/", gzipIfAccepted(assetFS, func(r *http.Request) bool {
		ext := strings.ToLower(filepath.Ext(r.URL.Path))
		switch ext {
		case ".js", ".css", ".html", ".svg", ".json", ".txt", ".map":
			return true
		default:
			return false
		}
	}))

	// favicon (serve a small svg; avoids embedding a binary .ico)
	mux.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		// Simple mark using our "folders" motif (Tabler-esque stroke icon).
		_, _ = io.WriteString(w, `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#eef2ff"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#g)" stroke="#cbd5e1" stroke-width="2"/>
  <g fill="none" stroke="#2563eb" stroke-linecap="round" stroke-linejoin="round" stroke-width="3">
    <path d="M24 18h8l5 5h13a6 6 0 0 1 6 6v16a6 6 0 0 1-6 6H24a6 6 0 0 1-6-6V24a6 6 0 0 1 6-6"/>
    <path d="M46 45v5a6 6 0 0 1-6 6H16a6 6 0 0 1-6-6V28a6 6 0 0 1 6-6h6"/>
  </g>
</svg>`)
	})

	// UI index (served for "/" within a share context too)
	inner.Handle("/", gzipIfAccepted(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		b, err := fs.ReadFile(s.webFS, "index.html")
		if err != nil {
			http.Error(w, "missing ui", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(b)
	}), func(r *http.Request) bool {
		return r.URL.Path == "/"
	}))

	if !s.disableAdmin {
		// Admin page
		inner.Handle("/admin", gzipIfAccepted(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/admin" {
				http.NotFound(w, r)
				return
			}
			ok, err := s.allowed(r, auth.PermAdmin, "/admin")
			if err != nil {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			if !ok {
				if s.shouldChallenge(r) {
					s.authChallenge(w)
				} else {
					http.Redirect(w, r, "/unauthorized", http.StatusFound)
				}
				return
			}
			b, err := fs.ReadFile(s.webFS, "admin.html")
			if err != nil {
				http.Error(w, "missing admin ui", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write(b)
		}), func(r *http.Request) bool { return r.URL.Path == "/admin" }))
	}

	inner.Handle("/unauthorized", gzipIfAccepted(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/unauthorized" {
			http.NotFound(w, r)
			return
		}
		b, err := fs.ReadFile(s.webFS, "unauthorized.html")
		if err != nil {
			http.Error(w, "missing unauthorized ui", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(b)
	}), func(r *http.Request) bool { return r.URL.Path == "/unauthorized" }))

	// file serving with Range
	inner.Handle("/f/", s.require(auth.PermRead, http.HandlerFunc(s.handleFile)))

	// thumbnails
	inner.Handle("/thumb", s.require(auth.PermRead, http.HandlerFunc(s.handleThumb)))

	// api
	inner.Handle("/api/list", s.require(auth.PermRead, http.HandlerFunc(s.handleList)))
	inner.Handle("/api/search", s.require(auth.PermRead, http.HandlerFunc(s.handleSearch)))
	inner.Handle("/api/mkdir", http.HandlerFunc(s.handleMkdir))
	inner.Handle("/api/rename", http.HandlerFunc(s.handleRename))
	inner.Handle("/api/delete", http.HandlerFunc(s.handleDelete))
	inner.Handle("/api/copy", http.HandlerFunc(s.handleCopy))
	inner.Handle("/api/move", http.HandlerFunc(s.handleMove))
	inner.Handle("/api/write", http.HandlerFunc(s.handleWrite))
	if !s.disableAdmin {
		inner.Handle("/api/admin/bcrypt", http.HandlerFunc(s.handleAdminBcrypt))
		inner.Handle("/api/admin/state", http.HandlerFunc(s.handleAdminState))
		inner.Handle("/api/admin/config", http.HandlerFunc(s.handleAdminConfig))
		inner.Handle("/api/admin/users", http.HandlerFunc(s.handleAdminUsers))
		inner.Handle("/api/admin/tokens", http.HandlerFunc(s.handleAdminTokens))
	}
	inner.Handle("/api/upload", s.require(auth.PermWrite, http.HandlerFunc(s.handleMultipartUpload)))

	// resumable uploads
	inner.Handle("/api/uploads", s.require(auth.PermWrite, http.HandlerFunc(s.handleUploads)))
	inner.Handle("/api/uploads/", http.HandlerFunc(s.handleUploadID))

	// zip (read) - supports multi-select downloads via POST
	inner.Handle("/api/zip", http.HandlerFunc(s.handleZip))
	inner.Handle("/api/zipls", s.require(auth.PermRead, http.HandlerFunc(s.handleZipList)))
	inner.Handle("/api/zipget", s.require(auth.PermRead, http.HandlerFunc(s.handleZipGet)))

	// Share dispatcher: supports / (default) and /s/<share>/...
	mux.Handle("/", s.dispatch(s.authWrap(inner)))

	return mux
}

func (s *Server) dispatch(inner http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if strings.HasPrefix(p, "/s/") {
			rest := strings.TrimPrefix(p, "/s/")
			i := strings.Index(rest, "/")
			if i < 0 {
				// /s/<share> -> redirect to /s/<share>/
				if rest != "" {
					http.Redirect(w, r, "/s/"+rest+"/", http.StatusFound)
					return
				}
				http.NotFound(w, r)
				return
			}
			share := rest[:i]
			if share == "" {
				http.NotFound(w, r)
				return
			}
			if _, ok := s.cfg.Shares[share]; !ok {
				http.NotFound(w, r)
				return
			}
			// Strip /s/<share> prefix.
			r2 := r.Clone(context.WithValue(r.Context(), shareKey, share))
			r2.URL.Path = rest[i:] // includes leading "/"
			inner.ServeHTTP(w, r2)
			return
		}
		inner.ServeHTTP(w, r.Clone(context.WithValue(r.Context(), shareKey, "")))
	})
}

func (s *Server) require(perm auth.Perm, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rel := fsutil.CleanRelPath(r.URL.Query().Get("path"))
		// Some routes use path in URL instead.
		if perm == auth.PermRead && strings.HasPrefix(r.URL.Path, "/f/") {
			rel = fsutil.CleanRelPath(strings.TrimPrefix(r.URL.Path, "/f/"))
		}
		clean := "/" + rel
		ok, err := s.allowed(r, perm, clean)
		if err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if !ok {
			if s.shouldChallenge(r) {
				s.authChallenge(w)
			} else {
				http.Error(w, "forbidden", http.StatusForbidden)
			}
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) allowed(r *http.Request, perm auth.Perm, cleanPath string) (bool, error) {
	user := auth.UserFromContext(r.Context())
	cfg := s.cfgForReq(r)
	return auth.Allowed(cfg, user, cleanPath, perm)
}

func (s *Server) shouldChallenge(r *http.Request) bool {
	cfg := s.cfgForReq(r)
	return (len(cfg.Users) > 0 || len(cfg.Tokens) > 0) && cfg.AuthOptional && auth.UserFromContext(r.Context()) == ""
}

func (s *Server) authChallenge(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Basic realm="lanparty"`)
	http.Error(w, "unauthorized", http.StatusUnauthorized)
}

func (s *Server) authWrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cfg := s.cfgForReq(r)
		if len(cfg.Users) == 0 && len(cfg.Tokens) == 0 {
			next.ServeHTTP(w, r)
			return
		}
		authz := r.Header.Get("Authorization")
		if cfg.AuthOptional && strings.TrimSpace(authz) == "" {
			next.ServeHTTP(w, r)
			return
		}
		// Bearer token
		if strings.HasPrefix(authz, "Bearer ") {
			tok := strings.TrimSpace(strings.TrimPrefix(authz, "Bearer "))
			if tok == "" {
				s.authChallenge(w)
				return
			}
			user := cfg.Tokens[tok]
			if user == "" {
				s.authChallenge(w)
				return
			}
			r = r.WithContext(auth.WithUser(r.Context(), user))
			next.ServeHTTP(w, r)
			return
		}
		// Basic
		u, p, ok := parseBasicAuthHeader(authz)
		if !ok {
			s.authChallenge(w)
			return
		}
		user, ok := cfg.Users[u]
		if !ok {
			s.authChallenge(w)
			return
		}
		if err := bcrypt.CompareHashAndPassword([]byte(user.Bcrypt), []byte(p)); err != nil {
			s.authChallenge(w)
			return
		}
		r = r.WithContext(auth.WithUser(r.Context(), u))
		next.ServeHTTP(w, r)
	})
}

func (s *Server) davPathToClean(urlPath string) string {
	// /dav/foo/bar -> /foo/bar
	p := strings.TrimPrefix(urlPath, "/dav")
	if p == "" {
		p = "/"
	}
	p = path.Clean(p)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	return p
}

// --- handlers ---

func (s *Server) handleFile(w http.ResponseWriter, r *http.Request) {
	rel := fsutil.CleanRelPath(strings.TrimPrefix(r.URL.Path, "/f/"))
	cfg := s.cfgForReq(r)
	abs, err := fsutil.ResolveWithinRoot(cfg.Root, rel, cfg.FollowSymlinks)
	if err != nil {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	st, err := os.Stat(abs)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if st.IsDir() {
		http.Error(w, "is a directory", http.StatusBadRequest)
		return
	}

	f, err := os.Open(abs)
	if err != nil {
		http.Error(w, "open failed", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	ct := contentTypeForName(st.Name())
	if ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if r.URL.Query().Get("dl") == "1" {
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", st.Name()))
	}
	http.ServeContent(w, r, st.Name(), st.ModTime(), f)
}

type listItem struct {
	Name   string `json:"name"`
	Path   string `json:"path"` // rel
	IsDir  bool   `json:"isDir"`
	IsLink bool   `json:"isLink,omitempty"`
	LinkTo string `json:"linkTo,omitempty"`
	Size   int64  `json:"size"`
	Mtime  int64  `json:"mtime"`
	Mime   string `json:"mime,omitempty"`
	Thumb  string `json:"thumb,omitempty"`
}

type readmeInfo struct {
	Path  string `json:"path"` // rel
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	rel := fsutil.CleanRelPath(r.URL.Query().Get("path"))
	cfg := s.cfgForReq(r)
	abs, err := fsutil.ResolveWithinRoot(cfg.Root, rel, cfg.FollowSymlinks)
	if err != nil {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	st, err := os.Stat(abs)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if !st.IsDir() {
		http.Error(w, "not a directory", http.StatusBadRequest)
		return
	}
	ents, err := os.ReadDir(abs)
	if err != nil {
		http.Error(w, "read failed", http.StatusInternalServerError)
		return
	}
	// optional README.md rendering in UI
	var readme *readmeInfo
	for _, cand := range []string{"README.md", "readme.md"} {
		p := filepath.Join(abs, cand)
		if st2, err := os.Stat(p); err == nil && st2.Mode().IsRegular() {
			readme = &readmeInfo{
				Path:  joinRel(rel, cand),
				Name:  cand,
				Size:  st2.Size(),
				Mtime: st2.ModTime().Unix(),
			}
			break
		}
	}
	items := make([]listItem, 0, len(ents))
	for _, e := range ents {
		info, err := e.Info()
		name := e.Name()
		childRel := joinRel(rel, name)
		childAbs := filepath.Join(abs, name)
		isLink := (e.Type() & os.ModeSymlink) != 0
		it := listItem{
			Name:   name,
			Path:   childRel,
			IsDir:  e.IsDir(),
			IsLink: isLink,
		}
		if info != nil && err == nil {
			it.Size = info.Size()
			it.Mtime = info.ModTime().Unix()
		}
		if isLink {
			if lt, err := os.Readlink(childAbs); err == nil {
				it.LinkTo = lt
			}
		}
		if !it.IsDir {
			ext := strings.ToLower(filepath.Ext(name))
			it.Mime = contentTypeForName(name)
			if isImageExt(ext) {
				it.Thumb = s.withSharePrefix(r, "/thumb?path="+urlQueryEscape(childRel))
			} else if isTextExt(ext) && it.Size > 0 && it.Size <= 1024*1024 {
				it.Thumb = s.withSharePrefix(r, "/thumb?path="+urlQueryEscape(childRel)+"&t=txt")
			}
		}
		items = append(items, it)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].IsDir != items[j].IsDir {
			return items[i].IsDir
		}
		return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
	})
	writeJSON(w, map[string]any{
		"path":   rel,
		"items":  items,
		"readme": readme,
	})
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	baseRel := fsutil.CleanRelPath(r.URL.Query().Get("path"))
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, map[string]any{"items": []listItem{}, "seen": 0, "truncated": false})
		return
	}
	cfg := s.cfgForReq(r)
	baseAbs, err := fsutil.ResolveWithinRoot(cfg.Root, baseRel, cfg.FollowSymlinks)
	if err != nil {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	// bounded search; scan hidden (dot) entries last for better UX
	const maxHits = 500
	const maxFiles = 200_000
	hits := make([]listItem, 0, 64)
	var seen int
	var truncated bool
	var truncReason string // "maxHits"|"maxFiles"
	qlow := strings.ToLower(q)

	type node struct {
		abs string
		rel string // slash-separated, "" for root
	}
	normalQ := make([]node, 0, 64)
	hiddenQ := make([]node, 0, 64)
	normalQ = append(normalQ, node{abs: baseAbs, rel: baseRel})

	isHidden := func(name string) bool {
		return strings.HasPrefix(name, ".")
	}
	pushDir := func(absDir, relDir, name string) {
		// do not follow symlinks (avoid loops)
		nrel := name
		if relDir != "" {
			nrel = relDir + "/" + name
		}
		nabs := filepath.Join(absDir, name)
		if isHidden(name) {
			hiddenQ = append(hiddenQ, node{abs: nabs, rel: nrel})
		} else {
			normalQ = append(normalQ, node{abs: nabs, rel: nrel})
		}
	}
	addHit := func(absPath string, rel string, d fs.DirEntry) {
		name := d.Name()
		info, _ := d.Info()
		it := listItem{
			Name:  name,
			Path:  rel,
			IsDir: d.IsDir(),
			Size:  0,
			Mtime: 0,
		}
		if info != nil {
			it.Size = info.Size()
			it.Mtime = info.ModTime().Unix()
		}
		if !it.IsDir {
			ext := strings.ToLower(filepath.Ext(name))
			it.Mime = contentTypeForName(name)
			if isImageExt(ext) {
				it.Thumb = s.withSharePrefix(r, "/thumb?path="+urlQueryEscape(rel))
			} else if isTextExt(ext) && it.Size > 0 && it.Size <= 1024*1024 {
				it.Thumb = s.withSharePrefix(r, "/thumb?path="+urlQueryEscape(rel)+"&t=txt")
			}
		}
		hits = append(hits, it)
	}

	var errStop = errors.New("stop")
	var errLimit = errors.New("limit")

	// process normal dirs first, then hidden dirs
	for len(normalQ) > 0 || len(hiddenQ) > 0 {
		var n node
		if len(normalQ) > 0 {
			n = normalQ[0]
			normalQ = normalQ[1:]
		} else {
			n = hiddenQ[0]
			hiddenQ = hiddenQ[1:]
		}

		// count the directory node itself against maxFiles (similar to WalkDir behaviour)
		seen++
		if seen > maxFiles {
			truncated = true
			truncReason = "maxFiles"
			break
		}

		ents, err := os.ReadDir(n.abs)
		if err != nil {
			continue
		}
		// ReadDir is already sorted; we just split into normal/hidden buckets.
		normalEnts := make([]os.DirEntry, 0, len(ents))
		hiddenEnts := make([]os.DirEntry, 0, 16)
		for _, e := range ents {
			if isHidden(e.Name()) {
				hiddenEnts = append(hiddenEnts, e)
			} else {
				normalEnts = append(normalEnts, e)
			}
		}
		processEnt := func(e os.DirEntry) error {
			seen++
			if seen > maxFiles {
				truncated = true
				truncReason = "maxFiles"
				return errLimit
			}
			name := e.Name()
			rel := name
			if n.rel != "" {
				rel = n.rel + "/" + name
			}
			// Match against the full relative path (not just basename).
			if strings.Contains(strings.ToLower(rel), qlow) {
				addHit(filepath.Join(n.abs, name), rel, e)
				if len(hits) >= maxHits {
					truncated = true
					truncReason = "maxHits"
					return errStop
				}
			}
			// queue dirs for later scanning
			if e.IsDir() && (e.Type()&os.ModeSymlink) == 0 {
				pushDir(n.abs, n.rel, name)
			}
			return nil
		}

		for _, e := range normalEnts {
			if err := processEnt(e); err != nil {
				if err == errStop || err == errLimit {
					break
				}
			}
		}
		if truncated {
			break
		}
		for _, e := range hiddenEnts {
			if err := processEnt(e); err != nil {
				if err == errStop || err == errLimit {
					break
				}
			}
		}
		if truncated {
			break
		}
	}

	writeJSON(w, map[string]any{
		"items":     hits,
		"seen":      seen,
		"truncated": truncated,
		"reason":    truncReason,
	})
}

func (s *Server) handleMkdir(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	rel := fsutil.CleanRelPath(req.Path)
	if ok, err := s.allowed(r, auth.PermWrite, "/"+rel); err != nil || !ok {
		if s.shouldChallenge(r) {
			s.authChallenge(w)
		} else {
			http.Error(w, "forbidden", http.StatusForbidden)
		}
		return
	}
	cfg := s.cfgForReq(r)
	abs, err := fsutil.ResolveWithinRoot(cfg.Root, rel, cfg.FollowSymlinks)
	if err != nil {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		http.Error(w, "mkdir failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func (s *Server) handleRename(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	fromRel := fsutil.CleanRelPath(req.From)
	toRel := fsutil.CleanRelPath(req.To)
	if ok, err := s.allowed(r, auth.PermWrite, "/"+fromRel); err != nil || !ok {
		if s.shouldChallenge(r) {
			s.authChallenge(w)
		} else {
			http.Error(w, "forbidden", http.StatusForbidden)
		}
		return
	}
	if ok, err := s.allowed(r, auth.PermWrite, "/"+toRel); err != nil || !ok {
		if s.shouldChallenge(r) {
			s.authChallenge(w)
		} else {
			http.Error(w, "forbidden", http.StatusForbidden)
		}
		return
	}
	cfg := s.cfgForReq(r)
	fromAbs, err := fsutil.ResolveWithinRoot(cfg.Root, fromRel, cfg.FollowSymlinks)
	if err != nil {
		http.Error(w, "bad from", http.StatusBadRequest)
		return
	}
	toAbs, err := fsutil.ResolveWithinRoot(cfg.Root, toRel, cfg.FollowSymlinks)
	if err != nil {
		http.Error(w, "bad to", http.StatusBadRequest)
		return
	}
	if err := os.MkdirAll(filepath.Dir(toAbs), 0o755); err != nil {
		http.Error(w, "mkdir failed", http.StatusInternalServerError)
		return
	}
	if err := os.Rename(fromAbs, toAbs); err != nil {
		http.Error(w, "rename failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	rel := fsutil.CleanRelPath(req.Path)
	if ok, err := s.allowed(r, auth.PermAdmin, "/"+rel); err != nil || !ok {
		if s.shouldChallenge(r) {
			s.authChallenge(w)
		} else {
			http.Error(w, "forbidden", http.StatusForbidden)
		}
		return
	}
	cfg := s.cfgForReq(r)
	abs, err := fsutil.ResolveWithinRoot(cfg.Root, rel, cfg.FollowSymlinks)
	if err != nil {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	if err := os.RemoveAll(abs); err != nil {
		http.Error(w, "delete failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func (s *Server) handleWrite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
		Mode    string `json:"mode,omitempty"` // overwrite|rename|skip|error
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	rel := fsutil.CleanRelPath(req.Path)
	if rel == "" {
		http.Error(w, "missing path", http.StatusBadRequest)
		return
	}
	mode := strings.ToLower(strings.TrimSpace(req.Mode))
	if mode == "" {
		mode = "overwrite"
	}
	if mode != "overwrite" && mode != "rename" && mode != "skip" && mode != "error" {
		http.Error(w, "bad mode", http.StatusBadRequest)
		return
	}
	if len(req.Content) > 2*1024*1024 {
		http.Error(w, "too large", http.StatusRequestEntityTooLarge)
		return
	}
	if ok, err := s.allowed(r, auth.PermWrite, "/"+rel); err != nil || !ok {
		if s.shouldChallenge(r) {
			s.authChallenge(w)
		} else {
			http.Error(w, "forbidden", http.StatusForbidden)
		}
		return
	}
	cfg := s.cfgForReq(r)
	abs, err := fsutil.ResolveWithinRoot(cfg.Root, rel, cfg.FollowSymlinks)
	if err != nil {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	if st, err := os.Stat(abs); err == nil {
		if st.IsDir() {
			http.Error(w, "is a directory", http.StatusBadRequest)
			return
		}
		switch mode {
		case "skip":
			writeJSON(w, map[string]any{"ok": true, "skipped": true, "path": rel})
			return
		case "error":
			http.Error(w, "destination exists", http.StatusConflict)
			return
		case "rename":
			parentRel := path.Dir("/" + rel)
			parentRel = strings.TrimPrefix(parentRel, "/")
			parentAbs, err := fsutil.ResolveWithinRoot(cfg.Root, parentRel, cfg.FollowSymlinks)
			if err != nil {
				http.Error(w, "bad path", http.StatusBadRequest)
				return
			}
			nm, err := uniqueNameInDir(parentAbs, filepath.Base(rel))
			if err != nil {
				http.Error(w, "write failed", http.StatusInternalServerError)
				return
			}
			rel = joinRel(parentRel, nm)
			abs, err = fsutil.ResolveWithinRoot(cfg.Root, rel, cfg.FollowSymlinks)
			if err != nil {
				http.Error(w, "bad path", http.StatusBadRequest)
				return
			}
		case "overwrite":
			// ok
		}
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		http.Error(w, "mkdir failed", http.StatusInternalServerError)
		return
	}
	tmp := abs + fmt.Sprintf(".tmp-%d", time.Now().UnixNano())
	if err := os.WriteFile(tmp, []byte(req.Content), 0o644); err != nil {
		http.Error(w, "write failed", http.StatusInternalServerError)
		return
	}
	if err := os.Rename(tmp, abs); err != nil {
		_ = os.Remove(tmp)
		http.Error(w, "write failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "path": rel})
}

func (s *Server) handleAdminBcrypt(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Admin-only. (In no-auth mode, everyone is admin.)
	if ok, err := s.allowed(r, auth.PermAdmin, "/"); err != nil || !ok {
		if s.shouldChallenge(r) {
			s.authChallenge(w)
		} else {
			http.Error(w, "forbidden", http.StatusForbidden)
		}
		return
	}
	var req struct {
		Password string `json:"password"`
		Cost     int    `json:"cost,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if req.Password == "" {
		http.Error(w, "missing password", http.StatusBadRequest)
		return
	}
	cost := req.Cost
	if cost == 0 {
		cost = bcrypt.DefaultCost
	}
	if cost < bcrypt.MinCost || cost > bcrypt.MaxCost {
		http.Error(w, "bad cost", http.StatusBadRequest)
		return
	}
	h, err := bcrypt.GenerateFromPassword([]byte(req.Password), cost)
	if err != nil {
		http.Error(w, "bcrypt failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"bcrypt": string(h)})
}

func (s *Server) adminOnly(w http.ResponseWriter, r *http.Request) bool {
	if ok, err := s.allowed(r, auth.PermAdmin, "/"); err != nil || !ok {
		if s.shouldChallenge(r) {
			s.authChallenge(w)
		} else {
			http.Error(w, "forbidden", http.StatusForbidden)
		}
		return false
	}
	return true
}

func (s *Server) persistConfig(cfg config.Config) error {
	s.cfgMu.RLock()
	path := s.cfgPath
	s.cfgMu.RUnlock()
	if strings.TrimSpace(path) == "" {
		return nil
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + fmt.Sprintf(".tmp-%d", time.Now().UnixNano())
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (s *Server) handleAdminState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.adminOnly(w, r) {
		return
	}
	cfg := s.cfgForReq(r)
	type tok struct {
		TokenPrefix string `json:"tokenPrefix"`
		User        string `json:"user"`
	}
	users := make([]string, 0, len(cfg.Users))
	for u := range cfg.Users {
		users = append(users, u)
	}
	sort.Strings(users)
	toks := make([]tok, 0, len(cfg.Tokens))
	for t, u := range cfg.Tokens {
		p := t
		if len(p) > 8 {
			p = p[:8]
		}
		toks = append(toks, tok{TokenPrefix: p, User: u})
	}
	sort.Slice(toks, func(i, j int) bool {
		if toks[i].User != toks[j].User {
			return toks[i].User < toks[j].User
		}
		return toks[i].TokenPrefix < toks[j].TokenPrefix
	})
	writeJSON(w, map[string]any{
		"users":      users,
		"tokens":     toks,
		"persisted":  strings.TrimSpace(s.cfgPath) != "",
		"configPath": s.cfgPath,
	})
}

type adminConfigPayload struct {
	Root           string                  `json:"root"`
	StateDir       string                  `json:"stateDir"`
	FollowSymlinks bool                    `json:"followSymlinks"`
	AuthOptional   bool                    `json:"authOptional"`
	ACLs           []config.ACL            `json:"acls"`
	Shares         map[string]config.Share `json:"shares"`
}

func (s *Server) handleAdminConfig(w http.ResponseWriter, r *http.Request) {
	if !s.adminOnly(w, r) {
		return
	}
	switch r.Method {
	case http.MethodGet:
		s.cfgMu.RLock()
		cfg := s.cfg
		s.cfgMu.RUnlock()
		writeJSON(w, map[string]any{
			"config":     makeAdminConfigPayload(cfg),
			"persisted":  strings.TrimSpace(s.cfgPath) != "",
			"configPath": s.cfgPath,
		})
	case http.MethodPut:
		var req adminConfigPayload
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}

		s.cfgMu.RLock()
		cfg := s.cfg
		s.cfgMu.RUnlock()

		cfg.Root = strings.TrimSpace(req.Root)
		cfg.StateDir = strings.TrimSpace(req.StateDir)
		cfg.AuthOptional = req.AuthOptional
		cfg.FollowSymlinks = req.FollowSymlinks
		cfg.ACLs = normalizeACLs(req.ACLs)
		cfg.Shares = cloneShareMap(req.Shares)

		normalized, err := normalizeConfig(cfg)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := s.persistConfig(normalized); err != nil {
			http.Error(w, fmt.Sprintf("persist config: %v", err), http.StatusInternalServerError)
			return
		}
		s.cfgMu.Lock()
		s.cfg = normalized
		s.cfgMu.Unlock()
		s.resetShareCaches()

		writeJSON(w, map[string]any{
			"ok":         true,
			"config":     makeAdminConfigPayload(normalized),
			"persisted":  strings.TrimSpace(s.cfgPath) != "",
			"configPath": s.cfgPath,
		})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleAdminUsers(w http.ResponseWriter, r *http.Request) {
	if !s.adminOnly(w, r) {
		return
	}
	switch r.Method {
	case http.MethodPost:
		var req struct {
			Username string `json:"username"`
			Password string `json:"password"`
			Cost     int    `json:"cost,omitempty"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		u := strings.TrimSpace(req.Username)
		if u == "" || strings.Contains(u, "\x00") || strings.Contains(u, ":") {
			http.Error(w, "bad username", http.StatusBadRequest)
			return
		}
		if req.Password == "" {
			http.Error(w, "missing password", http.StatusBadRequest)
			return
		}
		cost := req.Cost
		if cost == 0 {
			cost = bcrypt.DefaultCost
		}
		if cost < bcrypt.MinCost || cost > bcrypt.MaxCost {
			http.Error(w, "bad cost", http.StatusBadRequest)
			return
		}
		h, err := bcrypt.GenerateFromPassword([]byte(req.Password), cost)
		if err != nil {
			http.Error(w, "bcrypt failed", http.StatusInternalServerError)
			return
		}
		s.cfgMu.Lock()
		cfg := s.cfg
		if cfg.Users == nil {
			cfg.Users = map[string]config.User{}
		}
		cfg.Users[u] = config.User{Bcrypt: string(h)}
		s.cfg = cfg
		s.cfgMu.Unlock()
		_ = s.persistConfig(cfg)
		writeJSON(w, map[string]any{"ok": true, "username": u, "bcrypt": string(h), "persisted": strings.TrimSpace(s.cfgPath) != ""})
	case http.MethodDelete:
		var req struct {
			Username string `json:"username"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		u := strings.TrimSpace(req.Username)
		s.cfgMu.Lock()
		cfg := s.cfg
		if cfg.Users != nil {
			delete(cfg.Users, u)
		}
		// also revoke any tokens for this user
		if cfg.Tokens != nil {
			for t, tu := range cfg.Tokens {
				if tu == u {
					delete(cfg.Tokens, t)
				}
			}
		}
		s.cfg = cfg
		s.cfgMu.Unlock()
		_ = s.persistConfig(cfg)
		writeJSON(w, map[string]any{"ok": true, "persisted": strings.TrimSpace(s.cfgPath) != ""})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleAdminTokens(w http.ResponseWriter, r *http.Request) {
	if !s.adminOnly(w, r) {
		return
	}
	switch r.Method {
	case http.MethodPost:
		var req struct {
			Username string `json:"username"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		u := strings.TrimSpace(req.Username)
		if u == "" {
			http.Error(w, "missing username", http.StatusBadRequest)
			return
		}
		// Require that the user exists (so ACL logic makes sense).
		cfg := s.cfgForReq(r)
		if _, ok := cfg.Users[u]; !ok {
			http.Error(w, "unknown user", http.StatusBadRequest)
			return
		}
		// generate token
		var b [24]byte
		if _, err := rand.Read(b[:]); err != nil {
			http.Error(w, "token failed", http.StatusInternalServerError)
			return
		}
		tok := base64.RawURLEncoding.EncodeToString(b[:])

		s.cfgMu.Lock()
		cfg = s.cfg
		if cfg.Tokens == nil {
			cfg.Tokens = map[string]string{}
		}
		cfg.Tokens[tok] = u
		s.cfg = cfg
		s.cfgMu.Unlock()
		_ = s.persistConfig(cfg)
		writeJSON(w, map[string]any{"ok": true, "token": tok, "username": u, "persisted": strings.TrimSpace(s.cfgPath) != ""})
	case http.MethodDelete:
		var req struct {
			Token string `json:"token"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		tok := strings.TrimSpace(req.Token)
		if tok == "" {
			http.Error(w, "missing token", http.StatusBadRequest)
			return
		}
		s.cfgMu.Lock()
		cfg := s.cfg
		if cfg.Tokens != nil {
			delete(cfg.Tokens, tok)
		}
		s.cfg = cfg
		s.cfgMu.Unlock()
		_ = s.persistConfig(cfg)
		writeJSON(w, map[string]any{"ok": true, "persisted": strings.TrimSpace(s.cfgPath) != ""})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func makeAdminConfigPayload(cfg config.Config) adminConfigPayload {
	return adminConfigPayload{
		Root:           cfg.Root,
		StateDir:       cfg.StateDir,
		FollowSymlinks: cfg.FollowSymlinks,
		AuthOptional:   cfg.AuthOptional,
		ACLs:           cloneACLs(cfg.ACLs),
		Shares:         cloneShareMap(cfg.Shares),
	}
}

func cloneShareMap(in map[string]config.Share) map[string]config.Share {
	if len(in) == 0 {
		return map[string]config.Share{}
	}
	out := make(map[string]config.Share, len(in))
	for name, sh := range in {
		cp := sh
		cp.ACLs = cloneACLs(sh.ACLs)
		out[name] = cp
	}
	return out
}

func cloneACLs(in []config.ACL) []config.ACL {
	if len(in) == 0 {
		return nil
	}
	out := make([]config.ACL, len(in))
	for i, a := range in {
		out[i] = config.ACL{
			Path:  a.Path,
			Read:  cloneStringSlice(a.Read),
			Write: cloneStringSlice(a.Write),
			Admin: cloneStringSlice(a.Admin),
		}
	}
	return out
}

func cloneStringSlice(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	out := make([]string, len(in))
	copy(out, in)
	return out
}

func normalizeACLs(in []config.ACL) []config.ACL {
	if len(in) == 0 {
		return nil
	}
	out := make([]config.ACL, 0, len(in))
	for _, acl := range in {
		path := strings.TrimSpace(acl.Path)
		if path == "" || path == "/" {
			path = "/"
		} else {
			path = "/" + strings.Trim(strings.Trim(path, " "), "/")
		}
		out = append(out, config.ACL{
			Path:  path,
			Read:  cleanStringSlice(acl.Read),
			Write: cleanStringSlice(acl.Write),
			Admin: cleanStringSlice(acl.Admin),
		})
	}
	return out
}

func cleanStringSlice(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	out := make([]string, 0, len(in))
	for _, v := range in {
		t := strings.TrimSpace(v)
		if t == "" {
			continue
		}
		out = append(out, t)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func normalizeConfig(cfg config.Config) (config.Config, error) {
	cfg.Root = strings.TrimSpace(cfg.Root)
	cfg.StateDir = strings.TrimSpace(cfg.StateDir)
	if cfg.Root == "" && len(cfg.Shares) == 0 {
		return cfg, errors.New("configure a root path or at least one share")
	}

	if cfg.Root != "" {
		absRoot, err := filepath.Abs(cfg.Root)
		if err != nil {
			return cfg, fmt.Errorf("abs root: %w", err)
		}
		cfg.Root = absRoot

		stateDir := cfg.StateDir
		if stateDir == "" {
			stateDir = filepath.Join(cfg.Root, ".lanparty")
		} else {
			stateDir, err = filepath.Abs(stateDir)
			if err != nil {
				return cfg, fmt.Errorf("abs state dir: %w", err)
			}
		}
		if err := os.MkdirAll(stateDir, 0o755); err != nil {
			return cfg, fmt.Errorf("state dir: %w", err)
		}
		cfg.StateDir = stateDir
	} else if cfg.StateDir != "" {
		stateDir, err := filepath.Abs(cfg.StateDir)
		if err != nil {
			return cfg, fmt.Errorf("abs state dir: %w", err)
		}
		if err := os.MkdirAll(stateDir, 0o755); err != nil {
			return cfg, fmt.Errorf("state dir: %w", err)
		}
		cfg.StateDir = stateDir
	}

	cfg.ACLs = normalizeACLs(cfg.ACLs)
	shares, err := normalizeShares(cfg.Shares)
	if err != nil {
		return cfg, err
	}
	cfg.Shares = shares
	return cfg, nil
}

func normalizeShares(in map[string]config.Share) (map[string]config.Share, error) {
	if len(in) == 0 {
		return map[string]config.Share{}, nil
	}
	out := make(map[string]config.Share, len(in))
	for rawName, sh := range in {
		name := strings.TrimSpace(rawName)
		if name == "" {
			return nil, errors.New("share name cannot be empty")
		}
		if strings.ContainsAny(name, "/\\#?") {
			return nil, fmt.Errorf("share %q: name cannot contain /, \\\\, #, or ?", name)
		}
		if _, exists := out[name]; exists {
			return nil, fmt.Errorf("duplicate share name %q", name)
		}

		root := strings.TrimSpace(sh.Root)
		if root == "" {
			return nil, fmt.Errorf("share %q: missing root", name)
		}
		absRoot, err := filepath.Abs(root)
		if err != nil {
			return nil, fmt.Errorf("share %q: abs root: %w", name, err)
		}
		sh.Root = absRoot

		stateDir := strings.TrimSpace(sh.StateDir)
		if stateDir == "" {
			stateDir = filepath.Join(sh.Root, ".lanparty")
		} else {
			stateDir, err = filepath.Abs(stateDir)
			if err != nil {
				return nil, fmt.Errorf("share %q: abs state dir: %w", name, err)
			}
		}
		if err := os.MkdirAll(stateDir, 0o755); err != nil {
			return nil, fmt.Errorf("share %q: state dir: %w", name, err)
		}
		sh.StateDir = stateDir
		sh.ACLs = normalizeACLs(sh.ACLs)
		out[name] = sh
	}
	return out, nil
}

func (s *Server) resetShareCaches() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dedup = map[string]*dedup.Store{}
	s.uploads = map[string]*upload.Manager{}
	s.davLocks = map[string]webdav.LockSystem{}
}

func (s *Server) handleCopy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Paths     []string `json:"paths"`
		DestDir   string   `json:"destDir"`
		Mode      string   `json:"mode,omitempty"` // error|skip|overwrite|rename
		Overwrite bool     `json:"overwrite,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if len(req.Paths) == 0 {
		http.Error(w, "missing paths", http.StatusBadRequest)
		return
	}
	mode := strings.ToLower(strings.TrimSpace(req.Mode))
	if mode == "" {
		if req.Overwrite {
			mode = "overwrite"
		} else {
			mode = "error"
		}
	}
	if mode != "error" && mode != "skip" && mode != "overwrite" && mode != "rename" {
		http.Error(w, "bad mode", http.StatusBadRequest)
		return
	}
	destDirRel := fsutil.CleanRelPath(req.DestDir)
	cfg := s.cfgForReq(r)
	destDirAbs, err := fsutil.ResolveWithinRoot(cfg.Root, destDirRel, cfg.FollowSymlinks)
	if err != nil {
		http.Error(w, "bad dest", http.StatusBadRequest)
		return
	}
	if st, err := os.Stat(destDirAbs); err != nil || !st.IsDir() {
		http.Error(w, "dest is not a directory", http.StatusBadRequest)
		return
	}
	// Require write permission on destination dir.
	if ok, err := s.allowed(r, auth.PermWrite, "/"+destDirRel); err != nil || !ok {
		if s.shouldChallenge(r) {
			s.authChallenge(w)
		} else {
			http.Error(w, "forbidden", http.StatusForbidden)
		}
		return
	}

	type outItem struct {
		From   string `json:"from"`
		To     string `json:"to"`
		Status string `json:"status"` // ok|skipped|renamed|overwritten
	}
	out := make([]outItem, 0, len(req.Paths))
	for _, p := range req.Paths {
		srcRel := fsutil.CleanRelPath(p)
		if srcRel == "" {
			continue
		}
		// Require read permission on source.
		if ok, err := s.allowed(r, auth.PermRead, "/"+srcRel); err != nil || !ok {
			if s.shouldChallenge(r) {
				s.authChallenge(w)
			} else {
				http.Error(w, "forbidden", http.StatusForbidden)
			}
			return
		}

		srcAbs, err := fsutil.ResolveWithinRoot(cfg.Root, srcRel, cfg.FollowSymlinks)
		if err != nil {
			http.Error(w, "bad path", http.StatusBadRequest)
			return
		}
		st, err := os.Stat(srcAbs)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		base := filepath.Base(srcRel)
		if base == "" || base == "." || base == "/" {
			http.Error(w, "bad name", http.StatusBadRequest)
			return
		}
		dstName := base
		dstRel := joinRel(destDirRel, dstName)
		dstAbs, err := fsutil.ResolveWithinRoot(cfg.Root, dstRel, cfg.FollowSymlinks)
		if err != nil {
			http.Error(w, "bad dest", http.StatusBadRequest)
			return
		}
		// Require write permission on destination path.
		if ok, err := s.allowed(r, auth.PermWrite, "/"+dstRel); err != nil || !ok {
			if s.shouldChallenge(r) {
				s.authChallenge(w)
			} else {
				http.Error(w, "forbidden", http.StatusForbidden)
			}
			return
		}

		dstExists := false
		if _, err := os.Stat(dstAbs); err == nil {
			dstExists = true
		}
		status := "ok"
		if dstExists {
			switch mode {
			case "skip":
				out = append(out, outItem{From: srcRel, To: dstRel, Status: "skipped"})
				continue
			case "error":
				http.Error(w, "destination exists", http.StatusConflict)
				return
			case "rename":
				nm, err := uniqueNameInDir(destDirAbs, dstName)
				if err != nil {
					http.Error(w, "copy failed", http.StatusInternalServerError)
					return
				}
				dstName = nm
				dstRel = joinRel(destDirRel, dstName)
				dstAbs, err = fsutil.ResolveWithinRoot(cfg.Root, dstRel, cfg.FollowSymlinks)
				if err != nil {
					http.Error(w, "bad dest", http.StatusBadRequest)
					return
				}
				status = "renamed"
			case "overwrite":
				status = "overwritten"
			}
		}

		if err := validateTransferTargets(st, srcAbs, dstAbs); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if st.IsDir() {
			if err := copyDirNoSymlinks(srcAbs, dstAbs, mode == "overwrite"); err != nil {
				http.Error(w, "copy failed", http.StatusInternalServerError)
				return
			}
		} else {
			if err := copyFileAtomic(srcAbs, dstAbs, mode == "overwrite"); err != nil {
				if errors.Is(err, os.ErrExist) {
					http.Error(w, "destination exists", http.StatusConflict)
					return
				}
				http.Error(w, "copy failed", http.StatusInternalServerError)
				return
			}
		}
		out = append(out, outItem{From: srcRel, To: dstRel, Status: status})
	}
	writeJSON(w, map[string]any{"ok": true, "items": out})
}

func (s *Server) handleMove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Paths     []string `json:"paths"`
		DestDir   string   `json:"destDir"`
		Mode      string   `json:"mode,omitempty"` // error|skip|overwrite|rename
		Overwrite bool     `json:"overwrite,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if len(req.Paths) == 0 {
		http.Error(w, "missing paths", http.StatusBadRequest)
		return
	}
	mode := strings.ToLower(strings.TrimSpace(req.Mode))
	if mode == "" {
		if req.Overwrite {
			mode = "overwrite"
		} else {
			mode = "error"
		}
	}
	if mode != "error" && mode != "skip" && mode != "overwrite" && mode != "rename" {
		http.Error(w, "bad mode", http.StatusBadRequest)
		return
	}
	destDirRel := fsutil.CleanRelPath(req.DestDir)
	cfg := s.cfgForReq(r)
	destDirAbs, err := fsutil.ResolveWithinRoot(cfg.Root, destDirRel, cfg.FollowSymlinks)
	if err != nil {
		http.Error(w, "bad dest", http.StatusBadRequest)
		return
	}
	if st, err := os.Stat(destDirAbs); err != nil || !st.IsDir() {
		http.Error(w, "dest is not a directory", http.StatusBadRequest)
		return
	}
	// Require write permission on destination dir.
	if ok, err := s.allowed(r, auth.PermWrite, "/"+destDirRel); err != nil || !ok {
		if s.shouldChallenge(r) {
			s.authChallenge(w)
		} else {
			http.Error(w, "forbidden", http.StatusForbidden)
		}
		return
	}

	type outItem struct {
		From   string `json:"from"`
		To     string `json:"to"`
		Status string `json:"status"` // ok|skipped|renamed|overwritten
	}
	out := make([]outItem, 0, len(req.Paths))
	for _, p := range req.Paths {
		srcRel := fsutil.CleanRelPath(p)
		if srcRel == "" {
			continue
		}
		// moving implies write on source and dest
		if ok, err := s.allowed(r, auth.PermWrite, "/"+srcRel); err != nil || !ok {
			if s.shouldChallenge(r) {
				s.authChallenge(w)
			} else {
				http.Error(w, "forbidden", http.StatusForbidden)
			}
			return
		}
		srcAbs, err := fsutil.ResolveWithinRoot(cfg.Root, srcRel, cfg.FollowSymlinks)
		if err != nil {
			http.Error(w, "bad path", http.StatusBadRequest)
			return
		}
		st, err := os.Stat(srcAbs)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		base := filepath.Base(srcRel)
		if base == "" || base == "." || base == "/" {
			http.Error(w, "bad name", http.StatusBadRequest)
			return
		}
		dstName := base
		dstRel := joinRel(destDirRel, dstName)
		dstAbs, err := fsutil.ResolveWithinRoot(cfg.Root, dstRel, cfg.FollowSymlinks)
		if err != nil {
			http.Error(w, "bad dest", http.StatusBadRequest)
			return
		}
		if ok, err := s.allowed(r, auth.PermWrite, "/"+dstRel); err != nil || !ok {
			if s.shouldChallenge(r) {
				s.authChallenge(w)
			} else {
				http.Error(w, "forbidden", http.StatusForbidden)
			}
			return
		}
		dstExists := false
		if _, err := os.Stat(dstAbs); err == nil {
			dstExists = true
		}
		status := "ok"
		wipeDest := false
		if dstExists {
			switch mode {
			case "skip":
				out = append(out, outItem{From: srcRel, To: dstRel, Status: "skipped"})
				continue
			case "error":
				http.Error(w, "destination exists", http.StatusConflict)
				return
			case "rename":
				nm, err := uniqueNameInDir(destDirAbs, dstName)
				if err != nil {
					http.Error(w, "move failed", http.StatusInternalServerError)
					return
				}
				dstName = nm
				dstRel = joinRel(destDirRel, dstName)
				dstAbs, err = fsutil.ResolveWithinRoot(cfg.Root, dstRel, cfg.FollowSymlinks)
				if err != nil {
					http.Error(w, "bad dest", http.StatusBadRequest)
					return
				}
				status = "renamed"
			case "overwrite":
				status = "overwritten"
				wipeDest = true
			}
		}

		if err := validateTransferTargets(st, srcAbs, dstAbs); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if wipeDest {
			_ = os.RemoveAll(dstAbs)
		}

		// Try rename first.
		if err := os.MkdirAll(filepath.Dir(dstAbs), 0o755); err != nil {
			http.Error(w, "mkdir failed", http.StatusInternalServerError)
			return
		}
		if err := os.Rename(srcAbs, dstAbs); err != nil {
			// cross-device or other rename issues: copy+delete
			if st.IsDir() {
				if err := copyDirNoSymlinks(srcAbs, dstAbs, mode == "overwrite"); err != nil {
					http.Error(w, "move failed", http.StatusInternalServerError)
					return
				}
				if err := os.RemoveAll(srcAbs); err != nil {
					http.Error(w, "move failed", http.StatusInternalServerError)
					return
				}
			} else {
				if err := copyFileAtomic(srcAbs, dstAbs, mode == "overwrite"); err != nil {
					if errors.Is(err, os.ErrExist) {
						http.Error(w, "destination exists", http.StatusConflict)
						return
					}
					http.Error(w, "move failed", http.StatusInternalServerError)
					return
				}
				_ = os.Remove(srcAbs)
			}
		}
		out = append(out, outItem{From: srcRel, To: dstRel, Status: status})
	}
	writeJSON(w, map[string]any{"ok": true, "items": out})
}

func (s *Server) handleMultipartUpload(w http.ResponseWriter, r *http.Request) {
	rel := fsutil.CleanRelPath(r.URL.Query().Get("path"))
	mode := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("mode")))
	if mode == "" {
		mode = "overwrite"
	}
	if mode != "error" && mode != "skip" && mode != "overwrite" && mode != "rename" {
		http.Error(w, "bad mode", http.StatusBadRequest)
		return
	}
	cfg := s.cfgForReq(r)
	absDir, err := fsutil.ResolveWithinRoot(cfg.Root, rel, cfg.FollowSymlinks)
	if err != nil {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	if err := r.ParseMultipartForm(256 << 20); err != nil { // 256MiB memory+tmp
		http.Error(w, "bad multipart", http.StatusBadRequest)
		return
	}
	fh := firstFile(r.MultipartForm)
	if fh == nil {
		http.Error(w, "missing file", http.StatusBadRequest)
		return
	}
	src, err := fh.Open()
	if err != nil {
		http.Error(w, "open upload", http.StatusBadRequest)
		return
	}
	defer src.Close()

	store, _, err := s.shareDeps(r)
	if err != nil {
		http.Error(w, "server init failed", http.StatusInternalServerError)
		return
	}

	tmp := filepath.Join(cfg.StateDir, "uploads", fmt.Sprintf("mp-%d.tmp", time.Now().UnixNano()))
	if err := os.MkdirAll(filepath.Dir(tmp), 0o755); err != nil {
		http.Error(w, "tmp failed", http.StatusInternalServerError)
		return
	}
	dst, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		http.Error(w, "tmp failed", http.StatusInternalServerError)
		return
	}
	_, err = io.Copy(dst, src)
	_ = dst.Close()
	if err != nil {
		_ = os.Remove(tmp)
		http.Error(w, "upload failed", http.StatusInternalServerError)
		return
	}

	sha, blob, size, err := store.Put(r.Context(), tmp)
	if err != nil {
		http.Error(w, "dedup failed", http.StatusInternalServerError)
		return
	}

	// conflict handling
	dstRel := joinRel(rel, fh.Filename)
	dstAbs, err := fsutil.ResolveWithinRoot(cfg.Root, dstRel, cfg.FollowSymlinks)
	if err != nil {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	if _, err := os.Stat(dstAbs); err == nil {
		switch mode {
		case "skip":
			_ = os.Remove(tmp)
			writeJSON(w, map[string]any{"ok": true, "skipped": true, "path": dstRel})
			return
		case "error":
			_ = os.Remove(tmp)
			http.Error(w, "destination exists", http.StatusConflict)
			return
		case "rename":
			nm, err := uniqueNameInDir(absDir, filepath.Base(dstRel))
			if err != nil {
				http.Error(w, "write failed", http.StatusInternalServerError)
				return
			}
			dstRel = joinRel(rel, nm)
			dstAbs, err = fsutil.ResolveWithinRoot(cfg.Root, dstRel, cfg.FollowSymlinks)
			if err != nil {
				http.Error(w, "bad path", http.StatusBadRequest)
				return
			}
		case "overwrite":
			// ok
		}
	}
	if err := dedup.LinkOrCopy(blob, dstAbs); err != nil {
		http.Error(w, "write failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "sha256": sha, "size": size, "path": dstRel})
}

func firstFile(mf *multipart.Form) *multipart.FileHeader {
	if mf == nil || len(mf.File) == 0 {
		return nil
	}
	// Prefer key "file" if present.
	if v := mf.File["file"]; len(v) > 0 {
		return v[0]
	}
	// Else first key lexicographically for stable behavior.
	keys := make([]string, 0, len(mf.File))
	for k := range mf.File {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if v := mf.File[k]; len(v) > 0 {
			return v[0]
		}
	}
	return nil
}

func (s *Server) handleUploads(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		dest := fsutil.CleanRelPath(r.URL.Query().Get("path"))
		mode := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("mode")))
		if mode == "" {
			mode = "overwrite"
		}
		if mode != "error" && mode != "skip" && mode != "overwrite" && mode != "rename" {
			http.Error(w, "bad mode", http.StatusBadRequest)
			return
		}
		total := int64(-1)
		if v := r.URL.Query().Get("size"); v != "" {
			// best-effort
			if n, err := parseInt64(v); err == nil {
				total = n
			}
		}
		if dest == "" {
			http.Error(w, "missing path", http.StatusBadRequest)
			return
		}
		cfg := s.cfgForReq(r)
		// require write on destination path
		if ok, err := s.allowed(r, auth.PermWrite, "/"+dest); err != nil || !ok {
			if s.shouldChallenge(r) {
				s.authChallenge(w)
			} else {
				http.Error(w, "forbidden", http.StatusForbidden)
			}
			return
		}
		// conflict handling
		finalDest := dest
		destAbs, err := fsutil.ResolveWithinRoot(cfg.Root, dest, cfg.FollowSymlinks)
		if err != nil {
			http.Error(w, "bad path", http.StatusBadRequest)
			return
		}
		if _, err := os.Stat(destAbs); err == nil {
			switch mode {
			case "skip":
				writeJSON(w, map[string]any{"skipped": true, "path": dest})
				return
			case "error":
				http.Error(w, "destination exists", http.StatusConflict)
				return
			case "rename":
				parentRel := path.Dir("/" + dest)
				parentRel = strings.TrimPrefix(parentRel, "/")
				parentAbs, err := fsutil.ResolveWithinRoot(cfg.Root, parentRel, cfg.FollowSymlinks)
				if err != nil {
					http.Error(w, "bad path", http.StatusBadRequest)
					return
				}
				nm, err := uniqueNameInDir(parentAbs, filepath.Base(dest))
				if err != nil {
					http.Error(w, "create failed", http.StatusInternalServerError)
					return
				}
				finalDest = joinRel(parentRel, nm)
			case "overwrite":
				// ok
			}
		}

		_, up, err := s.shareDeps(r)
		if err != nil {
			http.Error(w, "server init failed", http.StatusInternalServerError)
			return
		}
		sess, err := up.Create(finalDest, total)
		if err != nil {
			http.Error(w, "create failed", http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"id": sess.ID, "offset": sess.Offset, "size": sess.Size, "dest": sess.DestRel})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleUploadID(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/uploads/")
	if rest == "" {
		http.NotFound(w, r)
		return
	}
	isFinish := strings.HasSuffix(rest, "/finish")
	id := rest
	if isFinish {
		id = strings.TrimSuffix(rest, "/finish")
	}
	id = strings.TrimSuffix(id, "/")

	// Path-aware ACL: resumable uploads are always write-scoped to the destination.
	cfg := s.cfgForReq(r)
	_, up, err := s.shareDeps(r)
	if err != nil {
		http.Error(w, "server init failed", http.StatusInternalServerError)
		return
	}
	sess, ok := up.Get(id)
	if !ok {
		http.NotFound(w, r)
		return
	}
	if ok2, err := s.allowed(r, auth.PermWrite, "/"+sess.DestRel); err != nil || !ok2 {
		if s.shouldChallenge(r) {
			s.authChallenge(w)
		} else {
			http.Error(w, "forbidden", http.StatusForbidden)
		}
		return
	}

	if isFinish {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		dst, sha, size, err := up.Finish(r.Context(), id)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				http.NotFound(w, r)
				return
			}
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		rel, _ := filepath.Rel(cfg.Root, dst)
		rel = filepath.ToSlash(rel)
		writeJSON(w, map[string]any{"ok": true, "path": rel, "sha256": sha, "size": size})
		return
	}

	switch r.Method {
	case http.MethodGet:
		writeJSON(w, map[string]any{"id": sess.ID, "offset": sess.Offset, "size": sess.Size, "dest": sess.DestRel})
	case http.MethodDelete:
		// cancel upload session
		if err := up.Cancel(id); err != nil && !errors.Is(err, os.ErrNotExist) {
			http.Error(w, "cancel failed", http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	case http.MethodPatch:
		sess, err := up.Patch(r.Context(), id, r)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				http.NotFound(w, r)
				return
			}
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, map[string]any{"id": sess.ID, "offset": sess.Offset, "size": sess.Size})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleZip(w http.ResponseWriter, r *http.Request) {
	// Supports:
	// - GET  /api/zip?path=<rel>
	// - POST /api/zip (form: paths=...&paths=...&name=...)
	// - POST /api/zip (json: {"paths":[...], "name":"..."})
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	type zipReq struct {
		Paths []string `json:"paths"`
		Name  string   `json:"name"`
	}

	var (
		paths []string
		name  string
	)

	if r.Method == http.MethodGet {
		p := fsutil.CleanRelPath(r.URL.Query().Get("path"))
		if p == "" {
			http.Error(w, "missing path", http.StatusBadRequest)
			return
		}
		paths = []string{p}
		name = filepath.Base(p)
	} else {
		ct := r.Header.Get("Content-Type")
		if strings.Contains(ct, "application/json") {
			var req zipReq
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, "bad json", http.StatusBadRequest)
				return
			}
			for _, p := range req.Paths {
				p = fsutil.CleanRelPath(p)
				if p != "" {
					paths = append(paths, p)
				}
			}
			name = strings.TrimSpace(req.Name)
		} else {
			if err := r.ParseForm(); err != nil {
				http.Error(w, "bad form", http.StatusBadRequest)
				return
			}
			for _, p := range r.Form["paths"] {
				p = fsutil.CleanRelPath(p)
				if p != "" {
					paths = append(paths, p)
				}
			}
			name = strings.TrimSpace(r.FormValue("name"))
			if len(paths) == 0 {
				// backward compat: allow POST with ?path=...
				p := fsutil.CleanRelPath(r.URL.Query().Get("path"))
				if p != "" {
					paths = []string{p}
				}
			}
		}
	}

	if len(paths) == 0 {
		http.Error(w, "missing paths", http.StatusBadRequest)
		return
	}

	// default zip name
	if name == "" {
		if len(paths) == 1 {
			name = filepath.Base(paths[0])
		} else {
			name = "download"
		}
	}
	name = sanitizeZipBaseName(name)

	// Enforce per-path read ACL.
	for _, p := range paths {
		ok, err := s.allowed(r, auth.PermRead, "/"+p)
		if err != nil || !ok {
			if s.shouldChallenge(r) {
				s.authChallenge(w)
			} else {
				http.Error(w, "forbidden", http.StatusForbidden)
			}
			return
		}
	}

	type item struct {
		rel string
		abs string
		st  os.FileInfo
	}
	cfg := s.cfgForReq(r)
	items := make([]item, 0, len(paths))
	for _, p := range paths {
		abs, err := fsutil.ResolveWithinRoot(cfg.Root, p, cfg.FollowSymlinks)
		if err != nil {
			http.Error(w, "bad path", http.StatusBadRequest)
			return
		}
		st, err := os.Stat(abs)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		items = append(items, item{rel: p, abs: abs, st: st})
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name+".zip"))
	zw := zip.NewWriter(w)
	defer zw.Close()

	ctx := r.Context()

	used := map[string]int{}
	uniqueTop := func(base string) string {
		base = sanitizeZipPath(base)
		if base == "" {
			base = "item"
		}
		n := used[base]
		used[base] = n + 1
		if n == 0 {
			return base
		}
		ext := filepath.Ext(base)
		b := strings.TrimSuffix(base, ext)
		return fmt.Sprintf("%s (%d)%s", b, n, ext)
	}

	addDir := func(baseAbs, baseRel string) error {
		return filepath.WalkDir(baseAbs, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if d.IsDir() {
				return nil
			}
			relp, err := filepath.Rel(baseAbs, p)
			if err != nil {
				return nil
			}
			zipPath := filepath.ToSlash(filepath.Join(baseRel, relp))
			zipPath = sanitizeZipPath(zipPath)
			if zipPath == "" {
				return nil
			}
			info, _ := d.Info()
			h := &zip.FileHeader{
				Name:     zipPath,
				Method:   zip.Deflate,
				Modified: time.Now(),
			}
			if info != nil {
				h.Modified = info.ModTime()
			}
			wr, err := zw.CreateHeader(h)
			if err != nil {
				return err
			}
			f, err := os.Open(p)
			if err != nil {
				return nil
			}
			_, _ = io.Copy(wr, f)
			_ = f.Close()
			return nil
		})
	}

	for _, it := range items {
		top := uniqueTop(filepath.Base(it.rel))
		if it.st.IsDir() {
			_ = addDir(it.abs, top)
			continue
		}
		top = sanitizeZipPath(top)
		wr, _ := zw.Create(top)
		f, err := os.Open(it.abs)
		if err == nil {
			_, _ = io.Copy(wr, f)
			_ = f.Close()
		}
	}
}

func (s *Server) handleZipList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rel := fsutil.CleanRelPath(r.URL.Query().Get("path"))
	if rel == "" {
		http.Error(w, "missing path", http.StatusBadRequest)
		return
	}
	cfg := s.cfgForReq(r)
	abs, err := fsutil.ResolveWithinRoot(cfg.Root, rel, cfg.FollowSymlinks)
	if err != nil {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	st, err := os.Stat(abs)
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	if strings.ToLower(filepath.Ext(abs)) != ".zip" {
		http.Error(w, "not a zip", http.StatusBadRequest)
		return
	}
	zr, err := zip.OpenReader(abs)
	if err != nil {
		http.Error(w, "open zip failed", http.StatusBadRequest)
		return
	}
	defer zr.Close()

	type ent struct {
		Name  string `json:"name"`
		IsDir bool   `json:"isDir"`
		Size  uint64 `json:"size"`
		CSize uint64 `json:"csize"`
		Mtime int64  `json:"mtime"`
	}
	const maxEntries = 5000
	out := make([]ent, 0, min(len(zr.File), 256))
	var truncated bool
	for i, f := range zr.File {
		if i >= maxEntries {
			truncated = true
			break
		}
		fi := f.FileInfo()
		isDir := fi != nil && fi.IsDir()
		out = append(out, ent{
			Name:  f.Name,
			IsDir: isDir || strings.HasSuffix(f.Name, "/"),
			Size:  f.UncompressedSize64,
			CSize: f.CompressedSize64,
			Mtime: f.Modified.Unix(),
		})
	}
	writeJSON(w, map[string]any{
		"path":      rel,
		"entries":   out,
		"truncated": truncated,
	})
}

func (s *Server) handleZipGet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rel := fsutil.CleanRelPath(r.URL.Query().Get("path"))
	entry := r.URL.Query().Get("entry")
	if rel == "" || strings.TrimSpace(entry) == "" {
		http.Error(w, "missing params", http.StatusBadRequest)
		return
	}

	cfg := s.cfgForReq(r)
	abs, err := fsutil.ResolveWithinRoot(cfg.Root, rel, cfg.FollowSymlinks)
	if err != nil {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	st, err := os.Stat(abs)
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	if strings.ToLower(filepath.Ext(abs)) != ".zip" {
		http.Error(w, "not a zip", http.StatusBadRequest)
		return
	}
	zr, err := zip.OpenReader(abs)
	if err != nil {
		http.Error(w, "open zip failed", http.StatusBadRequest)
		return
	}
	defer zr.Close()

	var zf *zip.File
	for _, f := range zr.File {
		if f.Name == entry {
			zf = f
			break
		}
	}
	if zf == nil {
		http.NotFound(w, r)
		return
	}
	if zf.FileInfo() != nil && zf.FileInfo().IsDir() {
		http.Error(w, "is a directory", http.StatusBadRequest)
		return
	}
	rc, err := zf.Open()
	if err != nil {
		http.Error(w, "open entry failed", http.StatusBadRequest)
		return
	}
	defer rc.Close()

	fn := path.Base(zf.Name)
	if fn == "" || fn == "." || fn == "/" {
		fn = "file"
	}
	if ct := contentTypeForName(fn); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", fn))
	_, _ = io.Copy(w, rc)
}

func (s *Server) handleThumb(w http.ResponseWriter, r *http.Request) {
	// Very small thumbnailer: supports jpg/png/gif input, outputs jpeg.
	rel := fsutil.CleanRelPath(r.URL.Query().Get("path"))
	max := 256
	kind := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("t"))) // ""|"txt"
	if sv := strings.TrimSpace(r.URL.Query().Get("s")); sv != "" {
		if n, err := strconv.Atoi(sv); err == nil {
			if n < 64 {
				n = 64
			}
			if n > 1024 {
				n = 1024
			}
			max = n
		}
	}
	cfg := s.cfgForReq(r)
	abs, err := fsutil.ResolveWithinRoot(cfg.Root, rel, cfg.FollowSymlinks)
	if err != nil {
		http.Error(w, "bad path", http.StatusBadRequest)
		return
	}
	st, err := os.Stat(abs)
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	ext := strings.ToLower(filepath.Ext(abs))
	if !isImageExt(ext) && !(kind == "txt" && isTextExt(ext)) {
		http.NotFound(w, r)
		return
	}

	thumbDir := filepath.Join(cfg.StateDir, "thumbs")
	_ = os.MkdirAll(thumbDir, 0o755)
	key := safeKey(rel) + "-" + fmt.Sprintf("%d", st.ModTime().Unix()) + "-" + fmt.Sprintf("%d", max) + "-" + kind + ".jpg"
	thumbPath := filepath.Join(thumbDir, key)

	// Strong cache key: changes when file mtime or requested size changes.
	etag := `"` + key + `"`
	if inm := r.Header.Get("If-None-Match"); inm != "" && strings.Contains(inm, etag) {
		w.Header().Set("ETag", etag)
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		w.WriteHeader(http.StatusNotModified)
		return
	}

	if b, err := os.ReadFile(thumbPath); err == nil {
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("ETag", etag)
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		_, _ = w.Write(b)
		return
	}
	var b []byte
	if kind == "txt" && isTextExt(ext) {
		b, err = s.thumbDo(key, func() ([]byte, error) { return makeTextThumb(abs, max) })
	} else {
		b, err = s.thumbDo(key, func() ([]byte, error) { return makeThumb(abs, max) })
	}
	if err != nil {
		http.NotFound(w, r)
		return
	}
	_ = os.WriteFile(thumbPath, b, 0o644)
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	_, _ = w.Write(b)
}

// --- helpers ---

func joinRel(parent, name string) string {
	if parent == "" {
		return name
	}
	return parent + "/" + name
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func (s *Server) thumbDo(key string, fn func() ([]byte, error)) ([]byte, error) {
	// Lazy init.
	s.thumbMu.Lock()
	if s.thumbInflight == nil {
		s.thumbInflight = map[string]*thumbCall{}
	}
	if s.thumbSem == nil {
		s.thumbSem = make(chan struct{}, 4) // small parallelism cap
	}
	if c, ok := s.thumbInflight[key]; ok {
		s.thumbMu.Unlock()
		<-c.done
		return c.b, c.err
	}
	c := &thumbCall{done: make(chan struct{})}
	s.thumbInflight[key] = c
	s.thumbMu.Unlock()

	// compute
	s.thumbSem <- struct{}{}
	b, err := fn()
	<-s.thumbSem

	s.thumbMu.Lock()
	c.b = b
	c.err = err
	close(c.done)
	delete(s.thumbInflight, key)
	s.thumbMu.Unlock()
	return b, err
}

func urlQueryEscape(s string) string {
	return url.QueryEscape(s)
}

func parseInt64(s string) (int64, error) {
	var n int64
	_, err := fmt.Sscanf(strings.TrimSpace(s), "%d", &n)
	return n, err
}

func copyFileAtomic(src, dst string, overwrite bool) error {
	if !overwrite {
		if _, err := os.Stat(dst); err == nil {
			return os.ErrExist
		}
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp := dst + fmt.Sprintf(".tmp-%d", time.Now().UnixNano())
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	_, cErr := io.Copy(out, in)
	sErr := out.Sync()
	clErr := out.Close()
	if cErr != nil {
		_ = os.Remove(tmp)
		return cErr
	}
	if sErr != nil {
		_ = os.Remove(tmp)
		return sErr
	}
	if clErr != nil {
		_ = os.Remove(tmp)
		return clErr
	}
	if overwrite {
		_ = os.Remove(dst)
	} else {
		if _, err := os.Stat(dst); err == nil {
			_ = os.Remove(tmp)
			return os.ErrExist
		}
	}
	return os.Rename(tmp, dst)
}

func copyDirNoSymlinks(srcDir, dstDir string, overwrite bool) error {
	// Create destination dir (or ensure it exists if overwrite allows).
	if st, err := os.Stat(dstDir); err == nil {
		if !st.IsDir() {
			if !overwrite {
				return os.ErrExist
			}
			_ = os.RemoveAll(dstDir)
		}
	}
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		return err
	}
	return filepath.WalkDir(srcDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		// Skip symlinks (avoid loops / escaping).
		if d.Type()&os.ModeSymlink != 0 {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(srcDir, p)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		dst := filepath.Join(dstDir, rel)
		if d.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		return copyFileAtomic(p, dst, overwrite)
	})
}

func isSameOrDescendant(parent, candidate string) bool {
	if parent == "" || candidate == "" {
		return false
	}
	parentClean := filepath.Clean(parent)
	candidateClean := filepath.Clean(candidate)
	if equalPaths(parentClean, candidateClean) {
		return true
	}
	if runtime.GOOS == "windows" {
		parentClean = strings.ToLower(parentClean)
		candidateClean = strings.ToLower(candidateClean)
	}
	sep := string(os.PathSeparator)
	if !strings.HasSuffix(parentClean, sep) {
		parentClean += sep
	}
	return strings.HasPrefix(candidateClean, parentClean)
}

func equalPaths(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

func validateTransferTargets(st os.FileInfo, srcAbs, dstAbs string) error {
	if st == nil {
		return errors.New("missing source info")
	}
	if st.IsDir() {
		if isSameOrDescendant(srcAbs, dstAbs) {
			return errors.New("destination is inside source")
		}
		return nil
	}
	if equalPaths(srcAbs, dstAbs) {
		return errors.New("destination matches source")
	}
	return nil
}

func uniqueNameInDir(dirAbs, base string) (string, error) {
	// "file.txt" -> "file (1).txt"
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	if stem == "" {
		stem = base
		ext = ""
	}
	for i := 1; i < 10_000; i++ {
		cand := fmt.Sprintf("%s (%d)%s", stem, i, ext)
		if _, err := os.Stat(filepath.Join(dirAbs, cand)); errors.Is(err, os.ErrNotExist) {
			return cand, nil
		}
	}
	return "", fmt.Errorf("no free name")
}

func isImageExt(ext string) bool {
	switch ext {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp":
		return true
	default:
		return false
	}
}

func isTextExt(ext string) bool {
	switch ext {
	case ".txt", ".log", ".md", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
		".go", ".js", ".ts", ".tsx", ".jsx", ".py", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".sh", ".css", ".html":
		return true
	default:
		return false
	}
}

func contentTypeForName(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if ext == "" {
		return ""
	}
	if ct := mime.TypeByExtension(ext); ct != "" {
		return ct
	}
	// Fallbacks for systems with sparse mime tables.
	switch ext {
	// images
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	// video
	case ".mp4":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	case ".mkv":
		return "video/x-matroska"
	case ".mov":
		return "video/quicktime"
	case ".avi":
		return "video/x-msvideo"
	// audio
	case ".mp3":
		return "audio/mpeg"
	case ".m4a":
		return "audio/mp4"
	case ".wav":
		return "audio/wav"
	case ".ogg":
		return "audio/ogg"
	case ".flac":
		return "audio/flac"
	// docs/text
	case ".pdf":
		return "application/pdf"
	case ".txt", ".log", ".md", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".go", ".js", ".ts", ".tsx", ".jsx", ".py", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".sh", ".css", ".html":
		return "text/plain; charset=utf-8"
	// archives
	case ".zip":
		return "application/zip"
	case ".tar":
		return "application/x-tar"
	case ".gz":
		return "application/gzip"
	default:
		return ""
	}
}

func safeKey(rel string) string {
	rel = strings.ReplaceAll(rel, "/", "_")
	rel = strings.ReplaceAll(rel, "\\", "_")
	rel = strings.ReplaceAll(rel, "..", "_")
	if rel == "" {
		rel = "root"
	}
	return rel
}

// Thumbnail generation lives in thumb.go

func sanitizeZipBaseName(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimSuffix(s, ".zip")
	s = strings.ReplaceAll(s, "\x00", "")
	s = strings.ReplaceAll(s, "/", "-")
	s = strings.ReplaceAll(s, "\\", "-")
	s = strings.Trim(s, ". ")
	if s == "" {
		return "download"
	}
	if len(s) > 120 {
		s = s[:120]
	}
	return s
}

func sanitizeZipPath(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	p = path.Clean("/" + p)
	p = strings.TrimPrefix(p, "/")
	p = strings.TrimPrefix(p, "../")
	p = strings.ReplaceAll(p, "\x00", "")
	p = strings.Trim(p, "/")
	if p == "." || p == "" {
		return ""
	}
	// Avoid extremely long zip paths.
	if len(p) > 240 {
		p = p[:240]
	}
	return p
}
