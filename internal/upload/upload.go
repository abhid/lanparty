package upload

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"lanparty/internal/dedup"
	"lanparty/internal/fsutil"
)

// A minimal resumable upload protocol:
// - POST   /api/uploads?path=<destRel>  => {id, offset}
// - PATCH  /api/uploads/<id> (Content-Range: bytes <start>-<end>/<total>) body=chunk
// - POST   /api/uploads/<id>/finish    => finalize into dest (dedup store)
//
// State is stored on disk in <stateDir>/uploads/<id>.{part,json}

type Manager struct {
	rootAbs  string
	dir      string
	dedup    *dedup.Store
	mu       sync.Mutex
	sessions map[string]*session
}

type session struct {
	ID      string `json:"id"`
	DestRel string `json:"destRel"`
	Size    int64  `json:"size"`   // total if known, else -1
	Offset  int64  `json:"offset"` // written bytes
	Created int64  `json:"created"`
}

func New(rootAbs, stateDir string, store *dedup.Store) (*Manager, error) {
	dir := filepath.Join(stateDir, "uploads")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	m := &Manager{
		rootAbs:  rootAbs,
		dir:      dir,
		dedup:    store,
		sessions: map[string]*session{},
	}
	_ = m.loadExisting()
	return m, nil
}

func (m *Manager) loadExisting() error {
	ents, err := os.ReadDir(m.dir)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(m.dir, e.Name()))
		if err != nil {
			continue
		}
		var s session
		if json.Unmarshal(b, &s) != nil {
			continue
		}
		if s.ID != "" {
			cp := s
			m.sessions[s.ID] = &cp
		}
	}
	return nil
}

func (m *Manager) Create(destRel string, total int64) (*session, error) {
	id, err := newID()
	if err != nil {
		return nil, err
	}
	destRel = fsutil.CleanRelPath(destRel)
	s := &session{
		ID:      id,
		DestRel: destRel,
		Size:    total,
		Offset:  0,
		Created: time.Now().Unix(),
	}
	m.mu.Lock()
	m.sessions[id] = s
	m.mu.Unlock()
	if err := m.save(s); err != nil {
		return nil, err
	}
	return s, nil
}

func (m *Manager) Get(id string) (*session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	if !ok {
		return nil, false
	}
	cp := *s
	return &cp, true
}

func (m *Manager) Patch(ctx context.Context, id string, r *http.Request) (*session, error) {
	m.mu.Lock()
	s, ok := m.sessions[id]
	m.mu.Unlock()
	if !ok {
		return nil, os.ErrNotExist
	}
	start, end, total, err := parseContentRange(r.Header.Get("Content-Range"))
	if err != nil {
		return nil, err
	}
	if start != s.Offset {
		return nil, fmt.Errorf("offset mismatch: have %d want %d", s.Offset, start)
	}
	if s.Size < 0 && total >= 0 {
		s.Size = total
	}
	if s.Size >= 0 && total >= 0 && s.Size != total {
		return nil, fmt.Errorf("size mismatch: have %d want %d", s.Size, total)
	}

	partPath := filepath.Join(m.dir, id+".part")
	f, err := os.OpenFile(partPath, os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return nil, err
	}

	// stream copy
	wrote, err := io.CopyN(f, r.Body, (end-start)+1)
	if err != nil {
		return nil, err
	}
	if wrote != (end-start)+1 {
		return nil, fmt.Errorf("short write: %d != %d", wrote, (end-start)+1)
	}
	if err := f.Sync(); err != nil {
		return nil, err
	}

	m.mu.Lock()
	s.Offset += wrote
	m.mu.Unlock()
	if err := m.save(s); err != nil {
		return nil, err
	}
	cp := *s
	return &cp, nil
}

func (m *Manager) Finish(ctx context.Context, id string) (dstAbs string, sha256hex string, size int64, err error) {
	m.mu.Lock()
	s, ok := m.sessions[id]
	m.mu.Unlock()
	if !ok {
		return "", "", 0, os.ErrNotExist
	}
	if s.Size >= 0 && s.Offset != s.Size {
		return "", "", 0, fmt.Errorf("upload incomplete: offset=%d size=%d", s.Offset, s.Size)
	}

	partPath := filepath.Join(m.dir, id+".part")
	st, err := os.Stat(partPath)
	if err != nil {
		return "", "", 0, err
	}
	if s.Size >= 0 && st.Size() != s.Size {
		return "", "", 0, fmt.Errorf("size mismatch: file=%d expected=%d", st.Size(), s.Size)
	}
	tmpPath := filepath.Join(m.dir, id+".tmp")
	_ = os.Remove(tmpPath)
	if err := os.Rename(partPath, tmpPath); err != nil {
		return "", "", 0, err
	}

	sha256hex, blobPath, size, err := m.dedup.Put(ctx, tmpPath)
	if err != nil {
		return "", "", 0, err
	}
	dstAbs, err = fsutil.JoinWithinRoot(m.rootAbs, s.DestRel)
	if err != nil {
		return "", "", 0, err
	}
	if err := dedup.LinkOrCopy(blobPath, dstAbs); err != nil {
		return "", "", 0, err
	}

	_ = os.Remove(filepath.Join(m.dir, id+".json"))
	m.mu.Lock()
	delete(m.sessions, id)
	m.mu.Unlock()

	return dstAbs, sha256hex, size, nil
}

func (m *Manager) save(s *session) error {
	b, _ := json.MarshalIndent(s, "", "  ")
	tmp := filepath.Join(m.dir, s.ID+".json.tmp")
	final := filepath.Join(m.dir, s.ID+".json")
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, final)
}

func newID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func parseContentRange(v string) (start, end, total int64, err error) {
	// "bytes <start>-<end>/<total>" where total may be "*"
	v = strings.TrimSpace(v)
	if !strings.HasPrefix(v, "bytes ") {
		return 0, 0, 0, errors.New("missing Content-Range (expected: bytes start-end/total)")
	}
	v = strings.TrimPrefix(v, "bytes ")
	parts := strings.SplitN(v, "/", 2)
	if len(parts) != 2 {
		return 0, 0, 0, errors.New("invalid Content-Range")
	}
	rng := parts[0]
	tot := parts[1]
	se := strings.SplitN(rng, "-", 2)
	if len(se) != 2 {
		return 0, 0, 0, errors.New("invalid Content-Range range")
	}
	start, err = strconv.ParseInt(se[0], 10, 64)
	if err != nil || start < 0 {
		return 0, 0, 0, errors.New("invalid Content-Range start")
	}
	end, err = strconv.ParseInt(se[1], 10, 64)
	if err != nil || end < start {
		return 0, 0, 0, errors.New("invalid Content-Range end")
	}
	if tot == "*" {
		total = -1
	} else {
		total, err = strconv.ParseInt(tot, 10, 64)
		if err != nil || total <= 0 || end >= total {
			return 0, 0, 0, errors.New("invalid Content-Range total")
		}
	}
	return start, end, total, nil
}


