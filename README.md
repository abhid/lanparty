## lanparty

`lanparty` is a single-binary Go web file browser / file server inspired by
[9001/copyparty](https://github.com/9001/copyparty). It focuses on LAN / self-hosted
setups, embeds its UI assets, and ships the same polished experience everywhere.

- **Repo:** https://github.com/abhid/lanparty  
- **Downloads:** https://github.com/abhid/lanparty/releases  
- **Example config:** [`lanparty.example.json`](./lanparty.example.json)

### Table of contents

- [Quick start](#quick-start)
- [Docker](#docker)
- [Downloads](#downloads)
- [Features at a glance](#features-at-a-glance)
- [UI tour](#ui-tour)
- [Authentication & authorization](#authentication--authorization)
- [Configuration](#configuration)
- [Shares & virtual roots](#shares--virtual-roots)
- [CLI flags](#cli-flags)
- [Environment variables](#environment-variables)
- [Admin UI](#admin-ui)
- [Upload workflows](#upload-workflows)
- [API overview](#api-overview)
- [WebDAV](#webdav)
- [Portable & symlinks](#portable--symlinks)
- [Releases & CI](#releases--ci)
- [Roadmap](#roadmap)
- [Credits](#credits)

### Quick start

```bash
git clone https://github.com/abhid/lanparty
cd lanparty
go run ./cmd/lanparty -root /path/to/share
```

Open `http://localhost:3923`. Add files to the root you pointed at; they appear instantly.

### Docker

The repo ships with a multi-stage `Dockerfile` so you can run lanparty next to your datasets,
preview files produced inside containers, or export generated artifacts without installing dependencies
on the host:

```bash
docker build -t lanparty .
docker run --rm -it \
  -p 3923:3923 \
  -v /srv/lanparty:/data \
  -e LANPARTY_ROOT=/data \
  -e LANPARTY_STATE_DIR=/data/.lanparty \
  lanparty
```

Mount your own root/state directories, then layer on additional env vars / CLI flags as needed,
for example `-follow-symlinks` or `LANPARTY_DISABLE_ADMIN=true` to lock down the admin UI.

### Downloads

We publish signed artifacts for Linux, macOS, and Windows on every tagged release. Grab the
latest zip/tarball from the [Releases page](https://github.com/abhid/lanparty/releases),
verify it with the accompanying `.sha256`, then run the binary:

```bash
./lanparty -root /srv/lanparty
```

All assets (HTML/CSS/JS/fonts/SVG icons) are embedded via `go:embed`, so you only need the
binary and your data.

### Features at a glance

#### Web UI
- Compact, responsive layout with embedded Inter + JetBrains Mono fonts.
- Left “Filesystem” tree with lazy loading, keyboard navigation, and muted guideline rails.
- Right pane shows directory rows or widescreen gallery thumbnails (toggleable).
- README markdown renderer (tables, task lists, images, GFM-lite) below the listing.
- Search UI with “NN matches for query”, path breadcrumbs, and bookmarkable URLs (`#/path?q=`).
- Toast notifications for copy link, delete, uploads, conflicts, etc.

#### File operations
- Selection model: row click selects, name click opens; icon acts as selection anchor.
- Shift-click range selection, Ctrl/Cmd+A select all, Ctrl/Cmd+C/X/V copy/move, Delete/Backspace triggers delete.
- Always-visible operations toolbar with tooltips and disabled states when actions aren’t available.
- Right-click context menu for open, preview, download zip, rename, copy link, delete, paste, new file, bulk rename.
- In-place rename editor and inline “new file” creator for quick text notes.

#### Uploads & transfers
- Drag/drop folders or files, paste from clipboard, or use the upload button.
- Resumable chunked uploads with pause/resume/retry queue UI and per-file progress toasts.
- Conflict policies (rename/overwrite/skip/error) on both resumable and multipart uploads.
- Content-addressed deduplication store with hardlink/copy fallback.
- Multi-select zip streaming downloads and browsing inside zip archives.

#### Media & previews
- Image, audio, video, PDF, and text/code previews with next/prev navigation + slideshow.
- Widescreen/gallery mode shows larger thumbnails with inline previews and hover autoplay.
- Parallel thumbnail pipeline with caching, eviction, and strong HTTP cache headers.
- EXIF display for photos, audio playlist controls, and “play all in folder” for media sets.

#### Server features
- Multi-share virtual roots (`/s/<name>/`) each with their own state dir, ACLs, dedup store, and upload sessions.
- HTTP range downloads, gzip/brotli for text assets, and improved MIME detection.
- Optional BasicAuth with bcrypt, bearer tokens, per-path ACLs (`read`/`write`/`admin`).
- WebDAV endpoint with safe filesystem wrapper respecting the symlink policy.
- CLI flags for portable mode, symlink traversal, and version stamping.

#### Admin & automation
- GitHub-style `/admin` console with sidebar panes (Server, ACLs, Shares, Users, Tokens, Tools) that mirrors the JSON config.
- Inline tables let you edit roots, state dirs, share metadata, ACL rules, and more with dirty-state tracking, Save/Discard buttons, and toast feedback.
- When lanparty runs with `-config`, saving writes directly back to that JSON file; otherwise the UI clearly marks changes as runtime-only.
- User/token management (create, delete, revoke, copy) plus a bcrypt generator live in the same UI, and every action has a matching REST endpoint.
- GitHub Actions build/release pipeline produces cross-platform binaries on every tag.

### UI tour

**Layout**
- Sidebar: filesystem tree titled “Filesystem” with vertical guide lines. Click to expand nodes, right-click for quick actions.
- Content: toolbar with file count and operations (Up, Upload, New Folder, New File, Copy, Paste, Delete, Zip, etc.).
- Rows: icon + name + metadata. Entire row toggles selection, name opens. Hover shows quick actions.
- README panel: renders `README.md`/`readme.md` directly under the rows with GitHub-style markdown.

**Selections**
- Simple click toggles selection; clicking again deselects.
- Shift-click selects ranges without highlighting text.
- Ctrl/Cmd-click toggles individual items without clearing the rest.

**Context menu**
- Right-click anywhere in the rows to open file operations (open, preview, copy link, copy path, rename, delete, new file, bulk rename).
- Right-click empty space for upload/paste shortcuts.

**Search**
- Press `/` or use the search bar. Results page shows `XX matches for "<query>"`.
- Each result displays the item plus its parent path in muted text.
- Search URLs are shareable/bookmarkable (`#/photos?q=cats`).
- Hidden directories and dotfiles are searched last to keep signal high.

**Preview modal**
- Supports images, video (hover autoplay muted), audio playlist, PDFs, and syntax-colored text/code.
- Buttons for previous/next slide, slideshow autoplay, open in new tab, download, and edit/save (for text).

**Uploads**
- Upload queue panel docks bottom-left with per-item controls (pause/resume/cancel/retry).
- Toast notifications mirror progress for quick glance updates.
- Drag/drop folders preserve hierarchy; shift-hover drop targets for nested destinations.

**Gallery / widescreen mode**
- Hides the sidebar, enlarges tiles, removes background fill, reintroduces thin borders.
- Long filenames wrap gracefully with ellipsis fallback; metadata sits below the thumbnail.

### Authentication & authorization

- **Users:** Defined in config with bcrypt hashes. Generate via `go run ./cmd/lanparty passwd -p 'secret'`.
- **Optional auth (`authOptional`)**: when `true`, anonymous visitors can browse until an action requires auth. Useful for “public read, authenticated write”.
- **Bearer tokens:** `Authorization: Bearer <token>` where the token maps to a user. Great for automation or CLI tools.
- **ACLs:** Ordered list of rules. First match wins. `read` covers listing/download, `write` covers uploads/rename/mkdir, `admin` covers delete, admin UI, server-side zips, etc.
- **Logging in:** Visit `/login`, or initiate any protected action and the browser will prompt for credentials. Tokens can be used headlessly.

### Configuration

Copy [`lanparty.example.json`](./lanparty.example.json) and adapt it. A trimmed example:

```json
{
  "root": "/srv/lanparty",
  "stateDir": "/srv/lanparty/.lanparty",
  "authOptional": true,
  "followSymlinks": false,

  "users": {
    "alice": { "bcrypt": "$2a$10$..." },
    "bob":   { "bcrypt": "$2a$10$..." }
  },

  "tokens": {
    "automation-token": "alice"
  },

  "acls": [
    {
      "path": "/",
      "read": ["*"],
      "write": ["alice", "bob"],
      "admin": ["alice"]
    }
  ]
}
```

Key fields:

- `root`: main filesystem root. Omit when only using `shares`.
- `stateDir`: where uploads/dedup/thumb caches live. Defaults to `<root>/.lanparty`.
- `authOptional`: allow anonymous read until an action demands auth.
- `users`: username → bcrypt hash (generated via `lanparty passwd`).
- `tokens`: token → username mapping for bearer auth.
- `acls`: ordered path rules with `read`/`write`/`admin` arrays. `*` matches any authenticated user; omit to restrict.
- `followSymlinks`: override default symlink traversal. Still locked to within the share root for safety.

Refer to the example config for advanced scenarios: per-share ACLs, public dropboxes, multiple tokens, etc.

> Tip: Everything above is editable from the `/admin` UI. When lanparty is started with `-config /path/to/config.json`, the **Save changes** button writes directly to that file (the UI shows the resolved path and whether disk writes are enabled). Without `-config`, edits still apply immediately but are marked “runtime only” and disappear after a restart.
>
> Prefer config-file-only workflows? Start lanparty with `-disable-admin` or export `LANPARTY_DISABLE_ADMIN=true` to remove `/admin` and the admin APIs entirely.

#### Admin ACL quick start

Add a dedicated rule for the admin console so you control who can open `/admin`:

```json
{
  "path": "/admin",
  "read": ["alice"],
  "write": ["alice"],
  "admin": ["alice"]
}
```

On startup, lanparty checks for such a rule. If none exists it generates a random `admin-xxxxx` user, adds an `/admin` ACL for that account, and prints the credentials to the terminal so that you can sign in once and immediately replace the bootstrap user with your own entry.

### Shares & virtual roots

Define a `shares` map to expose multiple folders:

```json
"shares": {
  "media": {
    "root": "/srv/media",
    "stateDir": "/srv/media/.lanparty",
    "followSymlinks": true,
    "acls": [
      { "path": "/", "read": ["*"], "write": ["alice"] }
    ]
  },
  "dropbox": {
    "root": "/srv/dropbox",
    "authOptional": true,
    "acls": [
      { "path": "/", "read": ["*"], "write": ["bob"], "admin": ["bob"] }
    ]
  }
}
```

- Web UI: `/s/<share>/`
- API: `/s/<share>/api/...`
- WebDAV: `/s/<share>/dav/`
- Uploads/dedup/thumb caches are isolated per share.

### CLI flags

| Flag | Default | Description |
| --- | --- | --- |
| `-addr` | `0.0.0.0:3923` | Listen address/port. |
| `-root` | _none_ | Root path when not using `-config`. |
| `-state` | `<root>/.lanparty` | Force a state directory. |
| `-config` | _none_ | Path to JSON config (see above). |
| `-portable` | `false` | Store all runtime state under `./.lanparty-state/…` (per-share subfolders). |
| `-follow-symlinks` | `false` | Allow symlink traversal that stays inside the share root. |
| `-disable-admin` | `false` | Turn off `/admin` plus every `/api/admin/*` endpoint (config-only edits). |
| `-version` | `false` | Print embedded version/commit/build info and exit. |

When both config and flags are supplied, flags act as defaults the config can override. Every
flag above also respects a `LANPARTY_*` environment variable (see below); supplying a CLI flag
wins over the env, and both are overridden by values coming from `-config`.

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `LANPARTY_ADDR` | `0.0.0.0:3923` | Listen address (same as `-addr`). |
| `LANPARTY_ROOT` | _empty_ | Root path when not using `-config`. |
| `LANPARTY_STATE_DIR` | `<root>/.lanparty` | Overrides the computed state dir. |
| `LANPARTY_CONFIG` | _empty_ | Path to JSON config. |
| `LANPARTY_PORTABLE` | `false` | Mirrors `-portable`. |
| `LANPARTY_FOLLOW_SYMLINKS` | `false` | Mirrors `-follow-symlinks`. |
| `LANPARTY_DISABLE_ADMIN` | `false` | Disables `/admin` and every `/api/admin/*` endpoint. |

Setters follow Go’s `strconv.ParseBool`, so `true/false`, `1/0`, and `yes/no` all work. The
resolved env value becomes the default seen by the matching CLI flag; providing the flag (or
config) still wins when double-specified.

### Admin UI

`/admin` is a GitHub-style settings surface that manipulates the same JSON you would edit by hand.

#### Access & bootstrap
- Every request must satisfy an ACL rule that grants `admin` permission to `/admin`. Reuse the “Admin ACL quick start” snippet above or tailor it per share.
- When no such rule exists, lanparty auto-generates a random `admin-xxxxx` user with a dedicated `/admin` ACL, prints the credentials once, and expects you to replace that bootstrap account immediately.

#### Layout & workflow
- The sidebar lists **Server**, **ACLs**, **Shares**, **Users**, **Tokens**, and **Tools** panes. Selecting one swaps the main content without a full page load.
- The summary stack shows the resolved config path, whether writes are persisted, and the last status message. Save/Discard buttons stay disabled until something changes.
- Saving calls `PUT /api/admin/config`; if lanparty was started with `-config`, the JSON file is rewritten atomically. Discard triggers `GET /api/admin/config` to reload from disk.

#### Config panes
- **Server**: Edit `root`, `stateDir`, `followSymlinks`, and `authOptional` via compact tables with inline hints.
- **ACLs**: Manage the global first-match list. Each row exposes read/write/admin arrays, path cleaning, and delete buttons. Entries are saved in the order shown, and the backend normalizes slashes/duplicates before persisting.
- **Shares**: Add/remove virtual roots, edit per-share roots/state dirs, and open a detail row to tweak share-specific ACLs without leaving the table. Share names map directly to `/s/<name>/`.

#### Accounts & tokens
- **Users**: Use the form at the top to enter username, password, and optional bcrypt cost. The table below lists existing users with delete actions. Saving persists to the config file when possible and always revokes associated tokens when a user is deleted.
- **Tokens**: Generate a bearer token for any existing user, copy it, and revoke it later. The list shows each token’s first eight characters plus the mapped username so you can identify secrets without dumping the entire value.

#### Tools
- **Bcrypt generator**: Browser-based helper for `POST /api/admin/bcrypt`, complete with cost control and copy-to-clipboard so you never have to leave the page for hashing.

#### Automation
- Everything in the UI is backed by documented endpoints: `GET/PUT /api/admin/config`, `GET /api/admin/state`, `POST/DELETE /api/admin/users`, `POST/DELETE /api/admin/tokens`, and `POST /api/admin/bcrypt`. All of them require an account with `admin` permission and return a `persisted` flag plus the active `configPath`, which is useful when scripting Terraform/Ansible style workflows.

### Upload workflows

1. **Resumable (recommended)**
   - `POST /api/uploads?path=<dest>&size=<bytes>&mode=rename`
   - `PATCH /api/uploads/<id>` with `Content-Range`.
   - `POST /api/uploads/<id>/finish`
2. **Multipart fallback**
   - `POST /api/upload?path=<dest>&mode=overwrite` with `multipart/form-data`.
3. **Drag/drop folders**
   - Frontend walks the `DataTransferItem` tree and enqueues each file, preserving directory layout.

Conflict handling values: `rename`, `overwrite`, `skip`, `error`.

### API overview

| Purpose | Endpoint |
| --- | --- |
| List directory | `GET /api/list?path=` |
| Search | `GET /api/search?q=&path=` |
| Download file | `GET /f/<path>?dl=1` (Range supported) |
| Stream zip | `POST /api/zip` (body: `paths[]=...`) |
| Create folder | `POST /api/mkdir` `{ "path": "docs/new" }` |
| Rename | `POST /api/rename` `{ "from": "a", "to": "b" }` |
| Delete | `POST /api/delete` `{ "paths": ["a","b"] }` |
| Copy/Move | `POST /api/copy` / `POST /api/move` with `{"sources":[],"dest":"","mode":"rename"}` |
| Write file | `POST /api/write` `{ "path": "notes/todo.txt", "data": "..." }` |
| Thumbnail | `GET /thumb?path=<rel>&w=256` |
| Admin config (read/save) | `GET /api/admin/config`, `PUT /api/admin/config` (body mirrors the JSON config). |
| Admin state summary | `GET /api/admin/state` → returns `users`, `tokens` (first 8 chars), `persisted`, `configPath`. |
| Admin users | `POST /api/admin/users` `{ "username": "...", "password": "...", "cost": 10 }`; `DELETE /api/admin/users` `{ "username": "..." }`. |
| Admin tokens | `POST /api/admin/tokens` `{ "username": "..." }`; `DELETE /api/admin/tokens` `{ "token": "..." }`. |
| Admin bcrypt | `POST /api/admin/bcrypt` `{ "password": "...", "cost": 10 }`. |

Each share has its own API namespace: `/s/<share>/api/...`.

> Admin endpoints only exist when lanparty starts without `-disable-admin` / `LANPARTY_DISABLE_ADMIN=true`.

### WebDAV

- Base path: `/dav/` (or `/s/<share>/dav/`).
- Uses the same auth + ACL model, so you can mount read-only or read/write shares.
- Backed by a symlink-safe filesystem wrapper that enforces `followSymlinks`.

### Portable & symlinks

- `-portable` keeps runtime state (uploads, dedup blobs, thumb cache, WebDAV locks) under `./.lanparty-state/`. Handy for USB/portable deployments or read-only shares.
- `-follow-symlinks` (or config `followSymlinks: true`) allows resolving symlinks/junctions **only** when the final resolved path remains inside the share root—a safe way to browse OneDrive/Dropbox links without risking escapes.

### Releases & CI

- `.github/workflows/build.yml` runs on every push to build/test and upload multi-OS artifacts.
- `.github/workflows/release.yml` runs on tag pushes (`v*`), embeds version metadata via `ldflags`, and uploads the binaries + checksums to the GitHub Release.
- Every binary prints `lanparty <version>` plus commit/time via `-version`.

### Roadmap

- OneDrive-style “detail view” (sortable columns, sticky headers, infinite scroll).
- Archive browsing (peek into zip, download single entry, stream-unzip).
- Server-side thumbnails for PDFs, text/code snippets, audio cover art.
- Background thumbnail worker pool with eviction/prefetching.
- Advanced streaming: stronger HTTP Range handling for all media types.
- Admin change history + approvals (diff the JSON before writes, optional dual-control).

### Credits

- Inspired by [9001/copyparty](https://github.com/9001/copyparty) and classic LAN party tooling.
- Icons sourced from [Tabler via icones](https://icones.js.org/collection/tabler).
- Fonts: [Inter](https://rsms.me/inter/) + [JetBrains Mono](https://www.jetbrains.com/lp/mono/).
