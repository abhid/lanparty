package config

// Config is intentionally small and JSON-friendly.
// If Users is empty, lanparty runs without auth.
type Config struct {
	// Root is the directory served by lanparty (read/write controlled by ACLs).
	Root string `json:"root"`

	// StateDir stores uploads, blob store, thumbs, and small metadata.
	// Default: <root>/.lanparty
	StateDir string `json:"stateDir"`

	// AuthOptional enables "public + authenticated" mode when Users is set:
	// - requests without Authorization are treated as anonymous
	// - requests with Authorization are validated; invalid creds get 401
	// Pair this with ACLs, e.g. read:["*"] and write:["alice"].
	AuthOptional bool `json:"authOptional,omitempty"`

	// Users is a map of username -> bcrypt hash.
	// Example:
	// "alice": {"bcrypt":"$2a$10$..."}
	Users map[string]User `json:"users,omitempty"`

	// ACLs is a simple first-match rule list by path prefix.
	// If empty:
	// - no-auth mode: allow read+write
	// - auth mode: allow read to all authenticated users, deny write
	ACLs []ACL `json:"acls,omitempty"`
}

type User struct {
	Bcrypt string `json:"bcrypt"`
}

type ACL struct {
	// Path is a prefix match, always interpreted as a clean path like "/photos".
	Path string `json:"path"`
	// Read allows listing/downloading.
	Read []string `json:"read,omitempty"` // usernames or "*"
	// Write allows upload/mkdir/rename/delete.
	Write []string `json:"write,omitempty"` // usernames
	// Admin allows server-side zip, thumbnails, and destructive ops.
	Admin []string `json:"admin,omitempty"` // usernames
}


