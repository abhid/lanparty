## lanparty

`lanparty` is a Go web-based file browser / file server for LANs and home networks.
It’s inspired by the “everything in one place” HTTP mindset of [9001/copyparty](https://github.com/9001/copyparty) (but lanparty is its own implementation, in Go).

### Features

- **Fast web UI** (compact + light)
  - Left **Filesystem** tree (lazy expand/collapse)
  - Directory list with thumbnails/icons
  - In-page **preview** (images/video/audio/pdf/text)
  - Right-click **context menu** for operations
  - Selection model: **row selects**, **name opens**
  - Multi-select → **Download zip**
  - If a folder contains `README.md`, it renders below the listing
- **HTTP downloads** with Range/resume: `GET /f/<path>`
  - Add `?dl=1` to force download (`Content-Disposition: attachment`)
- **Uploads**
  - **Resumable/chunked**: `POST /api/uploads` + `PATCH /api/uploads/{id}` + `POST /finish`
  - **Multipart**: `POST /api/upload?path=<dir>`
- **Dedup store**: content-addressed SHA256 blobs in `<stateDir>/blobs`, then hardlink/copy into the share
- **BasicAuth + path ACLs** (optional)
- **WebDAV**: `/dav/` (works with many OS clients)
- **Zip streaming**: multi-path POST `/api/zip` (used by multi-select UI)
- UI icons sourced via [icones](https://icones.js.org/)

### Quick start (no auth)

```bash
cd /home/adevireddy/src/lanparty
go run ./cmd/lanparty -root /path/to/share
```

Open `http://localhost:3923`.

### Auth + ACLs (recommended)

#### 1) Create bcrypt password hashes

```bash
go run ./cmd/lanparty passwd -p 'your-password'
```

#### 2) Create a config file

Copy `lanparty.example.json` → `lanparty.json` and paste the bcrypt output.

#### 3) Run

```bash
go run ./cmd/lanparty -config ./lanparty.json
```

### Configuration reference (`lanparty.json`)

```json
{
  "root": "/srv/lanparty",
  "stateDir": "/srv/lanparty/.lanparty",
  "authOptional": true,
  "users": {
    "alice": { "bcrypt": "$2a$10$..." }
  },
  "acls": [
    {
      "path": "/",
      "read": ["*"],
      "write": ["alice"],
      "admin": ["alice"]
    }
  ]
}
```

- **`root`**: directory served by lanparty.
- **`stateDir`**: runtime state (uploads, blobs, thumbs). Default: `<root>/.lanparty`.
- **`authOptional`**: when `true` and `users` is set, unauthenticated requests are allowed to proceed as **anonymous** (and ACLs decide what they can do). Requests with `Authorization` are validated; invalid creds get 401.
- **`users`**: username → bcrypt hash. If omitted/empty, lanparty runs **without auth**.
- **`acls`**: first-match rules by path prefix.
  - **`read`**: listing/download
  - **`write`**: uploads + mkdir + rename
  - **`admin`**: destructive ops (currently delete) and server-side zip if you choose to gate it that way

Default policy when auth is enabled but no ACLs:
- **read** allowed for any authenticated user
- **write/admin** denied

### “Public read, authenticated write”

To allow anyone to browse/download, but require login for uploads/changes:

- Set `"authOptional": true`
- Set ACLs like:
  - `read: ["*"]` (public)
  - `write: ["alice"]` (authenticated user(s))
  - `admin: ["alice"]` (optional)

#### How to “log in” in a browser

With optional auth, normal browsing won’t pop up a login dialog.
Use one of these:

- Visit `/login` in your browser (it returns a BasicAuth challenge).
- Or attempt a write action (upload/mkdir/rename/delete) and you’ll get a 401 challenge if you’re anonymous.

### Web UI usage

- **Select**
  - Click anywhere on a row to **select**
  - Cmd/Ctrl-click toggles selection
  - Shift-click range selects
- **Open**
  - Click the **name** to open (folders navigate; files preview/open)
- **Zip download**
  - Select multiple items → click **Download zip**
- **Context menu**
  - Right click row → open/preview/download/copy link/rename/delete/zip
- **README rendering**
  - If the directory has `README.md` (or `readme.md`), it renders beneath the listing (safe markdown).

### API / endpoints (high level)

This is not a “public API contract”, but useful for automation/debugging:

- **List directory**: `GET /api/list?path=<rel>`
  - returns `items[]` plus optional `readme`
- **Download**: `GET /f/<rel>` (Range supported), `GET /f/<rel>?dl=1` to force download
- **Thumbnail**: `GET /thumb?path=<rel>` (images → jpeg)
- **Zip**:
  - `GET /api/zip?path=<rel>`
  - `POST /api/zip` with repeated `paths` fields (`paths=a&paths=b`) and optional `name`
  - `POST /api/zip` JSON: `{"paths":["a","b"],"name":"..."}` (optional)
- **Mkdir**: `POST /api/mkdir` JSON `{ "path": "..." }`
- **Rename**: `POST /api/rename` JSON `{ "from": "...", "to": "..." }`
- **Delete**: `POST /api/delete` JSON `{ "path": "..." }`

### Resumable upload protocol

1) Create a session:

```text
POST /api/uploads?path=<destRel>&size=<bytes>
-> { "id": "...", "offset": 0, "size": <bytes> }
```

2) Upload chunks:

```text
PATCH /api/uploads/<id>
Content-Range: bytes <start>-<end>/<total>
<binary chunk>
-> { "id": "...", "offset": <newOffset>, "size": <total> }
```

3) Finalize:

```text
POST /api/uploads/<id>/finish
-> { "ok": true, "path": "...", "sha256": "...", "size": ... }
```

### WebDAV

WebDAV is served at `/dav/` and respects the same auth/ACL model.
Use it with Finder/Explorer, `davfs2`, `rclone`, etc.

### Notes / limitations

- **Security**: lanparty is best suited for LANs/VPNs. If you expose it to the internet, put it behind TLS + a hardened reverse proxy and restrict access.
- **Dedup linking**: lanparty attempts to **hardlink** blobs into the share; if that fails (different filesystem), it falls back to **copy**.
- **README markdown**: rendered “GFM-lite” and **safe** (raw HTML is not executed).

### Credits

- Inspiration: [9001/copyparty](https://github.com/9001/copyparty)
- Icons: [icones](https://icones.js.org/)


