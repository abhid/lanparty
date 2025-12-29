package dedup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

type Store struct {
	dir string
}

// New creates a content-addressed blob store at <stateDir>/blobs.
func New(stateDir string) (*Store, error) {
	dir := filepath.Join(stateDir, "blobs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Store{dir: dir}, nil
}

func (s *Store) BlobPath(sha256hex string) string {
	return filepath.Join(s.dir, sha256hex)
}

// Put moves tmpFile into the store keyed by SHA256, returning hash and blob path.
// If the blob already exists, tmpFile is removed and the existing blob is used.
func (s *Store) Put(ctx context.Context, tmpFile string) (sha256hex string, blobPath string, size int64, err error) {
	f, err := os.Open(tmpFile)
	if err != nil {
		return "", "", 0, err
	}
	defer f.Close()

	h := sha256.New()
	var n int64
	buf := make([]byte, 1024*1024)
	for {
		if ctx.Err() != nil {
			return "", "", 0, ctx.Err()
		}
		rn, rerr := f.Read(buf)
		if rn > 0 {
			_, _ = h.Write(buf[:rn])
			n += int64(rn)
		}
		if errors.Is(rerr, io.EOF) {
			break
		}
		if rerr != nil {
			return "", "", 0, rerr
		}
	}

	sum := hex.EncodeToString(h.Sum(nil))
	dst := s.BlobPath(sum)

	// fast path: blob exists
	if st, err := os.Stat(dst); err == nil && st.Mode().IsRegular() {
		_ = os.Remove(tmpFile)
		return sum, dst, st.Size(), nil
	}

	// move into place (atomic within filesystem)
	if err := os.Rename(tmpFile, dst); err != nil {
		// If rename failed due to cross-device, copy+fsync.
		if err2 := copyFile(tmpFile, dst); err2 != nil {
			return "", "", 0, fmt.Errorf("store blob: rename=%v copy=%v", err, err2)
		}
		_ = os.Remove(tmpFile)
	}
	return sum, dst, n, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer func() { _ = out.Close() }()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	if err := out.Sync(); err != nil {
		return err
	}
	return out.Close()
}

// LinkOrCopy tries to hardlink blob -> dst; if that fails, it copies.
func LinkOrCopy(blobPath, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	_ = os.Remove(dst)
	if err := os.Link(blobPath, dst); err == nil {
		return nil
	}
	return copyFile(blobPath, dst)
}


