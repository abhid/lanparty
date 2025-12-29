package httpserver

import (
	"archive/zip"
	"embed"
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
	"sort"
	"strings"
	"time"

	"golang.org/x/net/webdav"

	"lanparty/internal/auth"
	"lanparty/internal/config"
	"lanparty/internal/dedup"
	"lanparty/internal/fsutil"
	"lanparty/internal/upload"
)

type Options struct {
	Config config.Config
}

type Server struct {
	cfg    config.Config
	dedup  *dedup.Store
	uploads *upload.Manager

	webFS fs.FS
}

//go:embed web/index.html web/assets/* web/assets/fonts/*
var embeddedWeb embed.FS

func New(opts Options) (*Server, error) {
	store, err := dedup.New(opts.Config.StateDir)
	if err != nil {
		return nil, err
	}
	up, err := upload.New(opts.Config.Root, opts.Config.StateDir, store)
	if err != nil {
		return nil, err
	}
	sub, err := fs.Sub(embeddedWeb, "web")
	if err != nil {
		return nil, err
	}
	return &Server{
		cfg:     opts.Config,
		dedup:   store,
		uploads: up,
		webFS:   sub,
	}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// health
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, "ok\n")
	})

	// Login helper for browsers (triggers BasicAuth prompt).
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
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
	dav := &webdav.Handler{
		Prefix:     "/dav",
		FileSystem: webdav.Dir(s.cfg.Root),
		LockSystem: webdav.NewMemLS(),
	}
	mux.Handle("/dav/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
	mux.Handle("/assets/", http.StripPrefix("/assets/", http.FileServer(http.FS(assets))))

	// UI index
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
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
	})

	// file serving with Range
	mux.Handle("/f/", s.require(auth.PermRead, http.HandlerFunc(s.handleFile)))

	// thumbnails
	mux.Handle("/thumb", s.require(auth.PermRead, http.HandlerFunc(s.handleThumb)))

	// api
	mux.Handle("/api/list", s.require(auth.PermRead, http.HandlerFunc(s.handleList)))
	mux.Handle("/api/search", s.require(auth.PermRead, http.HandlerFunc(s.handleSearch)))
	mux.Handle("/api/mkdir", http.HandlerFunc(s.handleMkdir))
	mux.Handle("/api/rename", http.HandlerFunc(s.handleRename))
	mux.Handle("/api/delete", http.HandlerFunc(s.handleDelete))
	mux.Handle("/api/upload", s.require(auth.PermWrite, http.HandlerFunc(s.handleMultipartUpload)))

	// resumable uploads
	mux.Handle("/api/uploads", s.require(auth.PermWrite, http.HandlerFunc(s.handleUploads)))
	mux.Handle("/api/uploads/", http.HandlerFunc(s.handleUploadID))

	// zip (read) - supports multi-select downloads via POST
	mux.Handle("/api/zip", http.HandlerFunc(s.handleZip))

	return auth.RequireAuth(s.cfg, mux)
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
	return auth.Allowed(s.cfg, user, cleanPath, perm)
}

func (s *Server) shouldChallenge(r *http.Request) bool {
	return auth.HasAuth(s.cfg) && s.cfg.AuthOptional && auth.UserFromContext(r.Context()) == ""
}

func (s *Server) authChallenge(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", `Basic realm="lanparty"`)
	http.Error(w, "unauthorized", http.StatusUnauthorized)
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
	abs, err := fsutil.JoinWithinRoot(s.cfg.Root, rel)
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
	Name  string `json:"name"`
	Path  string `json:"path"` // rel
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
	Mime  string `json:"mime,omitempty"`
	Thumb string `json:"thumb,omitempty"`
}

type readmeInfo struct {
	Path  string `json:"path"` // rel
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	rel := fsutil.CleanRelPath(r.URL.Query().Get("path"))
	abs, err := fsutil.JoinWithinRoot(s.cfg.Root, rel)
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
		if err != nil {
			continue
		}
		name := e.Name()
		childRel := joinRel(rel, name)
		it := listItem{
			Name:  name,
			Path:  childRel,
			IsDir: e.IsDir(),
			Size:  info.Size(),
			Mtime: info.ModTime().Unix(),
		}
		if !it.IsDir {
			ext := strings.ToLower(filepath.Ext(name))
			it.Mime = contentTypeForName(name)
			if isImageExt(ext) {
				it.Thumb = "/thumb?path=" + urlQueryEscape(childRel)
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
	baseAbs, err := fsutil.JoinWithinRoot(s.cfg.Root, baseRel)
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
				it.Thumb = "/thumb?path=" + urlQueryEscape(rel)
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
	abs, err := fsutil.JoinWithinRoot(s.cfg.Root, rel)
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
	fromAbs, err := fsutil.JoinWithinRoot(s.cfg.Root, fromRel)
	if err != nil {
		http.Error(w, "bad from", http.StatusBadRequest)
		return
	}
	toAbs, err := fsutil.JoinWithinRoot(s.cfg.Root, toRel)
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
	abs, err := fsutil.JoinWithinRoot(s.cfg.Root, rel)
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

func (s *Server) handleMultipartUpload(w http.ResponseWriter, r *http.Request) {
	rel := fsutil.CleanRelPath(r.URL.Query().Get("path"))
	absDir, err := fsutil.JoinWithinRoot(s.cfg.Root, rel)
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

	tmp := filepath.Join(s.cfg.StateDir, "uploads", fmt.Sprintf("mp-%d.tmp", time.Now().UnixNano()))
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

	sha, blob, size, err := s.dedup.Put(r.Context(), tmp)
	if err != nil {
		http.Error(w, "dedup failed", http.StatusInternalServerError)
		return
	}

	dstAbs := filepath.Join(absDir, fh.Filename)
	if err := dedup.LinkOrCopy(blob, dstAbs); err != nil {
		http.Error(w, "write failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "sha256": sha, "size": size})
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
		total := int64(-1)
		if v := r.URL.Query().Get("size"); v != "" {
			// best-effort
			if n, err := parseInt64(v); err == nil {
				total = n
			}
		}
		sess, err := s.uploads.Create(dest, total)
		if err != nil {
			http.Error(w, "create failed", http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"id": sess.ID, "offset": sess.Offset, "size": sess.Size})
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
	sess, ok := s.uploads.Get(id)
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
		dst, sha, size, err := s.uploads.Finish(r.Context(), id)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				http.NotFound(w, r)
				return
			}
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		rel, _ := filepath.Rel(s.cfg.Root, dst)
		rel = filepath.ToSlash(rel)
		writeJSON(w, map[string]any{"ok": true, "path": rel, "sha256": sha, "size": size})
		return
	}

	switch r.Method {
	case http.MethodGet:
		writeJSON(w, map[string]any{"id": sess.ID, "offset": sess.Offset, "size": sess.Size, "dest": sess.DestRel})
	case http.MethodPatch:
		sess, err := s.uploads.Patch(r.Context(), id, r)
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
	items := make([]item, 0, len(paths))
	for _, p := range paths {
		abs, err := fsutil.JoinWithinRoot(s.cfg.Root, p)
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

func (s *Server) handleThumb(w http.ResponseWriter, r *http.Request) {
	// Very small thumbnailer: supports jpg/png/gif input, outputs jpeg.
	rel := fsutil.CleanRelPath(r.URL.Query().Get("path"))
	abs, err := fsutil.JoinWithinRoot(s.cfg.Root, rel)
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
	if !isImageExt(ext) {
		http.NotFound(w, r)
		return
	}

	thumbDir := filepath.Join(s.cfg.StateDir, "thumbs")
	_ = os.MkdirAll(thumbDir, 0o755)
	key := safeKey(rel) + "-" + fmt.Sprintf("%d", st.ModTime().Unix()) + ".jpg"
	thumbPath := filepath.Join(thumbDir, key)
	if b, err := os.ReadFile(thumbPath); err == nil {
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		_, _ = w.Write(b)
		return
	}
	b, err := makeThumb(abs, 256)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	_ = os.WriteFile(thumbPath, b, 0o644)
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age=3600")
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

func urlQueryEscape(s string) string {
	return url.QueryEscape(s)
}

func parseInt64(s string) (int64, error) {
	var n int64
	_, err := fmt.Sscanf(strings.TrimSpace(s), "%d", &n)
	return n, err
}

func isImageExt(ext string) bool {
	switch ext {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp":
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


