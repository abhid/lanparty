package fsutil

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
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

// ResolveWithinRoot resolves rel under rootAbs with an explicit symlink policy.
//
// - If followSymlinks is false: rejects any request whose resolved path would traverse a symlink
//   in any existing path component (prevents symlink escape).
// - If followSymlinks is true: evaluates symlinks and requires the resolved path to remain within rootAbs.
//
// This function is for security: JoinWithinRoot blocks ".." escapes, but it does not defend against
// symlinks inside the root pointing outside.
func ResolveWithinRoot(rootAbs string, rel string, followSymlinks bool) (string, error) {
	joined, err := JoinWithinRoot(rootAbs, rel)
	if err != nil {
		return "", err
	}
	rootClean := filepath.Clean(rootAbs)

	if !followSymlinks {
		// Reject if any existing component in the path is a symlink.
		rel = CleanRelPath(rel)
		if rel == "" {
			return joined, nil
		}
		cur := rootClean
		parts := strings.Split(filepath.FromSlash(rel), string(filepath.Separator))
		for _, p := range parts {
			if p == "" {
				continue
			}
			cur = filepath.Join(cur, p)
			st, err := os.Lstat(cur)
			if err != nil {
				// If the component doesn't exist, remaining components also don't exist yet.
				// That's fine for create flows; we already ensured JoinWithinRoot containment.
				if errors.Is(err, fs.ErrNotExist) {
					return joined, nil
				}
				return "", err
			}
			if st.Mode()&os.ModeSymlink != 0 {
				return "", fmt.Errorf("symlink traversal disabled")
			}
		}
		return joined, nil
	}

	// followSymlinks == true:
	// Evaluate symlinks and ensure the resolved path stays within the resolved root.
	rootReal, err := filepath.EvalSymlinks(rootClean)
	if err != nil {
		// If root can't be eval'ed, fall back to cleaned root.
		rootReal = rootClean
	}
	var real string
	if _, err := os.Stat(joined); err == nil {
		real, err = filepath.EvalSymlinks(joined)
		if err != nil {
			return "", err
		}
	} else {
		// For non-existing destinations, resolve the parent directory.
		parent := filepath.Dir(joined)
		parentReal, err := filepath.EvalSymlinks(parent)
		if err != nil {
			return "", err
		}
		real = filepath.Join(parentReal, filepath.Base(joined))
	}
	real = filepath.Clean(real)
	rootReal = filepath.Clean(rootReal)
	if real != rootReal && !strings.HasPrefix(real, rootReal+string(filepath.Separator)) {
		return "", fmt.Errorf("symlink escape")
	}
	return real, nil
}


