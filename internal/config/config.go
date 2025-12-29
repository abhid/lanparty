package config

// Config is intentionally small and JSON-friendly.
// If Users is empty, lanparty runs without auth.
type Config struct {
	// Root is the directory served by lanparty (read/write controlled by ACLs).
	Root string `json:"root"`

	// StateDir stores uploads, blob store, thumbs, and small metadata.
	// Default: <root>/.lanparty
	StateDir string `json:"stateDir"`

	// Shares defines additional virtual roots served under /s/<name>/.
	// If empty, only the default share at "/" (Root/StateDir) is served.
	// Each share can have its own Root/StateDir and optional ACL override.
	Shares map[string]Share `json:"shares,omitempty"`

	// FollowSymlinks controls whether lanparty may follow symlinks/junctions inside a share.
	// Default: false (safer; symlinks are shown but not traversed/opened).
	// If true, lanparty only follows symlinks which resolve to a path still inside the share root.
	FollowSymlinks bool `json:"followSymlinks,omitempty"`

	// AuthOptional enables "public + authenticated" mode when Users is set:
	// - requests without Authorization are treated as anonymous
	// - requests with Authorization are validated; invalid creds get 401
	// Pair this with ACLs, e.g. read:["*"] and write:["alice"].
	AuthOptional bool `json:"authOptional,omitempty"`

	// Users is a map of username -> bcrypt hash.
	// Example:
	// "alice": {"bcrypt":"$2a$10$..."}
	Users map[string]User `json:"users,omitempty"`

	// Tokens maps bearer tokens to usernames.
	// Request header: Authorization: Bearer <token>
	// The token authenticates as the mapped username (ACLs still apply).
	Tokens map[string]string `json:"tokens,omitempty"`

	// ACLs is a simple first-match rule list by path prefix.
	// If empty:
	// - no-auth mode: allow read+write
	// - auth mode: allow read to all authenticated users, deny write
	ACLs []ACL `json:"acls,omitempty"`

}

// Share is a virtual root mounted under /s/<name>/.
type Share struct {
	// Root is the filesystem root for this share (required).
	Root string `json:"root"`
	// StateDir stores uploads/dedup/thumbs for this share.
	// Default: <root>/.lanparty
	StateDir string `json:"stateDir,omitempty"`
	// ACLs optionally overrides top-level ACLs for this share.
	ACLs []ACL `json:"acls,omitempty"`
	// FollowSymlinks overrides the global FollowSymlinks setting for this share when set.
	FollowSymlinks *bool `json:"followSymlinks,omitempty"`
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


