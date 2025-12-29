package auth

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"

	"golang.org/x/crypto/bcrypt"

	"lanparty/internal/config"
)

type ctxKey string

const userKey ctxKey = "lanparty.user"

func UserFromContext(ctx context.Context) string {
	v, _ := ctx.Value(userKey).(string)
	return v
}

func WithUser(ctx context.Context, user string) context.Context {
	return context.WithValue(ctx, userKey, user)
}

func HasAuth(cfg config.Config) bool {
	return len(cfg.Users) > 0
}

// RequireAuth wraps a handler with optional BasicAuth.
// - If cfg.Users is empty: allow all.
// - Else:
//   - if cfg.AuthOptional is false: require valid basic auth
//   - if cfg.AuthOptional is true: allow anonymous; validate creds if present
func RequireAuth(cfg config.Config, next http.Handler) http.Handler {
	if !HasAuth(cfg) {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if cfg.AuthOptional && r.Header.Get("Authorization") == "" {
			// anonymous request
			next.ServeHTTP(w, r)
			return
		}
		u, p, ok := parseBasicAuth(r.Header.Get("Authorization"))
		if !ok {
			deny(w)
			return
		}
		user, ok := cfg.Users[u]
		if !ok {
			deny(w)
			return
		}
		if err := bcrypt.CompareHashAndPassword([]byte(user.Bcrypt), []byte(p)); err != nil {
			deny(w)
			return
		}
		r = r.WithContext(WithUser(r.Context(), u))
		next.ServeHTTP(w, r)
	})
}

func deny(w http.ResponseWriter) {
	// constant-ish work
	_ = subtle.ConstantTimeByteEq(1, 1)
	w.Header().Set("WWW-Authenticate", `Basic realm="lanparty"`)
	http.Error(w, "unauthorized", http.StatusUnauthorized)
}

func parseBasicAuth(v string) (user, pass string, ok bool) {
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

// ACL evaluation.
type Perm int

const (
	PermRead Perm = iota + 1
	PermWrite
	PermAdmin
)

func Allowed(cfg config.Config, user string, cleanPath string, perm Perm) (bool, error) {
	// cleanPath must be slash-path beginning with "/" or "" for root.
	if cleanPath == "" {
		cleanPath = "/"
	}
	if !strings.HasPrefix(cleanPath, "/") {
		return false, errors.New("invalid cleanPath")
	}

	// no-auth mode: allow everything
	if !HasAuth(cfg) {
		return true, nil
	}

	// First-match ACL by prefix.
	for _, a := range cfg.ACLs {
		ap := a.Path
		if ap == "" {
			ap = "/"
		}
		if !strings.HasPrefix(ap, "/") {
			ap = "/" + ap
		}
		if ap != "/" && strings.HasSuffix(ap, "/") {
			ap = strings.TrimSuffix(ap, "/")
		}
		if cleanPath == ap || strings.HasPrefix(cleanPath, ap+"/") || (ap == "/" && strings.HasPrefix(cleanPath, "/")) {
			switch perm {
			case PermRead:
				return containsUser(a.Read, user), nil
			case PermWrite:
				if user == "" {
					return false, nil
				}
				return containsUser(a.Write, user), nil
			case PermAdmin:
				if user == "" {
					return false, nil
				}
				return containsUser(a.Admin, user), nil
			default:
				return false, errors.New("unknown perm")
			}
		}
	}

	// Default policy when auth enabled but no ACLs:
	// - allow read to authenticated users
	// - deny write/admin
	switch perm {
	case PermRead:
		return user != "", nil
	case PermWrite, PermAdmin:
		return false, nil
	default:
		return false, errors.New("unknown perm")
	}
}

func containsUser(list []string, u string) bool {
	for _, v := range list {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		if v == "*" || subtle.ConstantTimeCompare([]byte(v), []byte(u)) == 1 {
			return true
		}
	}
	return false
}


