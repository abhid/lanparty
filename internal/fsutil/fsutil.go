package fsutil

import (
	"errors"
	"path"
	"path/filepath"
	"strings"
)

// CleanRelPath takes a user path like "", ".", "/a/b", "a//b", and returns a
// safe, slash-based, no-leading-slash relative path ("" means root).
func CleanRelPath(p string) string {
	p = strings.TrimSpace(p)
	if p == "" || p == "." || p == "/" {
		return ""
	}
	p = strings.ReplaceAll(p, "\\", "/")
	p = path.Clean("/" + p) // force absolute for stable cleaning
	p = strings.TrimPrefix(p, "/")
	if p == "." {
		return ""
	}
	return p
}

// JoinWithinRoot returns an absolute filesystem path under root for a given rel
// path. It rejects escapes (..).
func JoinWithinRoot(rootAbs string, rel string) (string, error) {
	rel = CleanRelPath(rel)
	if rel == "" {
		return rootAbs, nil
	}
	if strings.Contains(rel, "\x00") {
		return "", errors.New("invalid path")
	}
	abs := filepath.Join(rootAbs, filepath.FromSlash(rel))
	absClean := filepath.Clean(abs)
	rootClean := filepath.Clean(rootAbs)
	if absClean != rootClean && !strings.HasPrefix(absClean, rootClean+string(filepath.Separator)) {
		return "", errors.New("path escape")
	}
	return absClean, nil
}


