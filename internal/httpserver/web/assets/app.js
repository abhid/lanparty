const $ = (id) => document.getElementById(id);

const rows = $("rows");
const crumbs = $("crumbs");
const statusEl = $("status");
const searchEl = $("search");
const fileEl = $("file");
const fileDirEl = $("filedir");
const opUp = $("op-up");
const opUpload = $("op-upload");
const opUploadDir = $("op-upload-dir");
const opMkdir = $("op-mkdir");
const opCopy = $("op-copy");
const opCut = $("op-cut");
const opPaste = $("op-paste");
const opZip = $("op-zip");
const opClear = $("op-clear");
const opWide = $("op-wide");

const modal = $("modal");
const modalBackdrop = $("modal-backdrop");
const pvClose = $("pv-close");
const pvPrev = $("pv-prev");
const pvNext = $("pv-next");
const pvSlide = $("pv-slide");
const pvEdit = $("pv-edit");
const pvSave = $("pv-save");
const pvTitle = $("pv-title");
const pvBody = $("pv-body");
const pvOpen = $("pv-open");
const pvDownload = $("pv-download");

const spv = $("spv");
const spvTitle = $("spv-title");
const spvBody = $("spv-body");
const spvOpen = $("spv-open");
const spvDownload = $("spv-download");

let statusBase = "";

const readmeEl = $("readme");
const readmeBody = $("readme-body");
const readmeOpen = $("readme-open");

const ctx = $("ctx");
let ctxOpen = false;
let ctxItem = null;

const treeEl = $("tree");
const treeCache = new Map(); // rel -> {dirs:[{name,path}], loaded:boolean}
const treeOpen = new Set(); // rel paths expanded

const toasts = $("toasts");
const upqEl = $("upq");
const upqBody = $("upq-body");
const upqClear = $("upq-clear");

let sortKey = "name"; // name|size|mtime
let sortDir = 1; // 1 asc, -1 desc

let lastList = [];
let selected = new Set();
let lastClickedIndex = -1;
let ren = null; // {path, value}
let renFocus = null; // path to focus after rerender

let wideMode = false;

const CLIP_KEY = "lanparty.clip";
let clip = null; // {op:"copy"|"cut", paths:[...], base:string, ts:number}

let pvCtx = null; // {items:[listItem], idx:number}
let pvSlideTimer = null;
let pvEditState = null; // {path, name, content, dirty}

let lazyObs = null;
function lazyInit() {
  if (lazyObs || !("IntersectionObserver" in window)) return;
  lazyObs = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target;
      const src = el?.dataset?.src;
      if (src && !el.src) {
        el.src = src;
        try { el.load?.(); } catch {}
      }
      lazyObs.unobserve(el);
    }
  }, {rootMargin: "400px 0px"});
}

function lazyObserve(el, src) {
  if (!el || !src) return;
  lazyInit();
  if (!lazyObs) {
    el.src = src;
    return;
  }
  el.dataset.src = src;
  lazyObs.observe(el);
}

function encPath(rel) {
  // encode each segment so "/a b/c" becomes "/a%20b/c"
  if (!rel) return "";
  return rel.split("/").map(encodeURIComponent).join("/");
}

function curPath() {
  return parseView().rel;
}

function setPath(rel) {
  setView(rel, "");
}

function parseView() {
  const h = (location.hash || "#/").slice(1); // "/path?...”
  if (!h.startsWith("/")) return {rel: "", q: ""};
  const [pathPart, queryPart] = h.split("?", 2);
  const rel = (pathPart || "/").slice(1).replace(/^\/+/, "");
  const sp = new URLSearchParams(queryPart || "");
  const q = (sp.get("q") || "").trim();
  return {rel, q};
}

function setView(rel, q) {
  rel = (rel || "").replace(/^\/+/, "");
  const sp = new URLSearchParams();
  const qq = (q || "").trim();
  if (qq) sp.set("q", qq);
  const qs = sp.toString();
  location.hash = "#/" + rel + (qs ? `?${qs}` : "");
}

function fmtSize(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  const u = ["KiB","MiB","GiB","TiB"];
  let x = n;
  let i = -1;
  while (x >= 1024 && i < u.length-1) { x /= 1024; i++; }
  return `${x.toFixed(x < 10 ? 1 : 0)} ${u[i]}`;
}

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}

function setStatus(msg) {
  statusBase = msg || "";
  updateStatusText();
}

function updateStatusText() {
  const s = selected.size;
  if (!statusEl) return;
  statusEl.textContent = s > 0 ? `${statusBase} · ${s} selected` : statusBase;
}

function pruneToasts() {
  if (!toasts) return;
  while (toasts.children.length > 4) {
    // Prefer dropping non-confirm toasts first so we don't strand pending confirmations.
    let victim = null;
    for (const ch of toasts.children) {
      if (!ch.classList?.contains("confirm")) {
        victim = ch;
        break;
      }
    }
    if (!victim) victim = toasts.firstElementChild;
    victim?.remove();
  }
}

function toast(msg, opts = {}) {
  if (!toasts) return;
  const type = opts.type || "ok"; // ok|err|info
  const sub = opts.sub || "";
  const dur = opts.dur ?? 2600;
  const prog0 = (opts.progress == null) ? null : Number(opts.progress);

  const el = document.createElement("div");
  el.className = `toast ${type}`;

  const iconId = type === "err" ? "close" : (type === "ok" ? "check" : "link");
  const i = document.createElement("div");
  i.className = "ti";
  i.innerHTML = iconUse(iconId);

  const msgEl = document.createElement("div");
  msgEl.className = "msg";
  msgEl.textContent = msg;
  const subEl = document.createElement("div");
  subEl.className = "sub";
  subEl.textContent = sub || "";
  if (sub || prog0 != null) msgEl.appendChild(subEl);

  const x = document.createElement("button");
  x.type = "button";
  x.className = "x";
  x.innerHTML = iconUse("close");
  x.onclick = () => el.remove();

  const row = document.createElement("div");
  row.className = "trow";
  row.appendChild(i);
  row.appendChild(msgEl);
  row.appendChild(x);
  el.appendChild(row);

  let barEl = null;
  if (prog0 != null) {
    const p = document.createElement("div");
    p.className = "tprog";
    const b = document.createElement("div");
    b.className = "tbar";
    b.style.width = `${Math.max(0, Math.min(100, prog0))}%`;
    p.appendChild(b);
    el.appendChild(p);
    barEl = b;
  }

  el.onclick = () => el.remove();

  toasts.appendChild(el);
  pruneToasts();
  if (dur > 0) {
    window.setTimeout(() => {
      if (el.isConnected) el.remove();
    }, dur);
  }

  return {
    el,
    setSub: (s) => {
      if (!subEl) return;
      const txt = s || "";
      subEl.textContent = txt;
      if (txt && !subEl.isConnected) msgEl.appendChild(subEl);
      if (!txt && subEl.isConnected && !barEl) subEl.remove();
    },
    setProgress: (pct) => {
      if (!barEl) return;
      const p = Math.max(0, Math.min(100, Number(pct)));
      barEl.style.width = `${p}%`;
    },
    close: () => el.remove(),
  };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fallback: hidden textarea + execCommand
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// Share-aware base path:
// - default share: ""
// - named share:  "/s/<share>"
const BASE = (() => {
  try {
    const p = String(location.pathname || "/");
    const m = p.match(/^\/s\/([^/]+)(?:\/|$)/);
    if (m && m[1]) return `/s/${m[1]}`;
  } catch {}
  return "";
})();

function fileUrl(rel, opts = {}) {
  const base = `${BASE}/f/${encPath(rel)}`;
  if (opts.dl) return `${base}?dl=1`;
  return base;
}

function classify(item) {
  if (item.isDir) return "folder";
  const name = (item.name || "").toLowerCase();
  const mime = (item.mime || "").toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  if (mime.startsWith("image/") || [".jpg",".jpeg",".png",".gif",".webp",".bmp"].includes(ext)) return "image";
  if (mime.startsWith("video/") || [".mp4",".webm",".mkv",".mov",".avi"].includes(ext)) return "video";
  if (mime.startsWith("audio/") || [".mp3",".m4a",".wav",".ogg",".flac"].includes(ext)) return "audio";
  if (mime.includes("pdf") || ext === ".pdf") return "pdf";
  if ([".zip",".tar",".gz",".7z",".rar"].includes(ext)) return "archive";
  if (mime.startsWith("text/") || ["application/json","application/xml"].includes(mime) || [".txt",".log",".md",".json",".yaml",".yml",".toml",".ini",".cfg",".conf",".go",".js",".ts",".tsx",".jsx",".py",".rs",".java",".c",".h",".cpp",".hpp",".sh",".css",".html"].includes(ext)) return "text";
  return "file";
}

function isPreviewable(kind) {
  return ["image","video","audio","pdf","text","archive"].includes(kind);
}

function iconUse(id) {
  return `<svg class="i" aria-hidden="true"><use href="/assets/icons.svg#${id}"></use></svg>`;
}

function rerenderRows() {
  if (!rows) return;
  rows.innerHTML = "";
  for (const it of (lastList || [])) rows.appendChild(rowFor(it));
}

function applySort() {
  const key = sortKey;
  const dir = sortDir;
  lastList = (lastList || []).slice().sort((a, b) => {
    if (!a || !b) return 0;
    // folders first
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let av, bv;
    if (key === "size") {
      av = Number(a.size || 0);
      bv = Number(b.size || 0);
    } else if (key === "mtime") {
      av = Number(a.mtime || 0);
      bv = Number(b.mtime || 0);
    } else {
      av = String(a.name || "").toLowerCase();
      bv = String(b.name || "").toLowerCase();
    }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

function updateSortHeader() {
  const ths = document.querySelectorAll(".thead .sort");
  ths.forEach((el) => {
    const k = el.getAttribute("data-sort");
    let label = (k === "name" ? "Name" : (k === "size" ? "Size" : "Modified"));
    if (k === sortKey) label += sortDir > 0 ? " ▲" : " ▼";
    el.textContent = label;
  });
}

function thumbUrl(u, size) {
  if (!u) return u;
  const s = Number(size) || 0;
  if (s <= 0) return u;
  return u + (u.includes("?") ? "&" : "?") + `s=${encodeURIComponent(String(s))}`;
}

function loadClip() {
  try {
    const raw = localStorage.getItem(CLIP_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (!c || (c.op !== "copy" && c.op !== "cut")) return null;
    if (!Array.isArray(c.paths) || c.paths.length === 0) return null;
    if (typeof c.base !== "string") c.base = "";
    if (typeof c.ts !== "number") c.ts = Date.now();
    return c;
  } catch {
    return null;
  }
}

function saveClip(c) {
  try {
    if (!c) localStorage.removeItem(CLIP_KEY);
    else localStorage.setItem(CLIP_KEY, JSON.stringify(c));
  } catch {}
}

function setClip(op, paths) {
  const ps = (paths || []).filter(Boolean);
  if (ps.length === 0) return;
  clip = {op, paths: ps, base: BASE, ts: Date.now()};
  saveClip(clip);
  updateSelectionUI();
  toast(op === "cut" ? "Cut to clipboard" : "Copied to clipboard", {type: "ok", sub: `${ps.length} item(s)`});
}

function clearClip() {
  clip = null;
  saveClip(null);
  updateSelectionUI();
}

function choiceToast(msg, opts = {}) {
  // Returns Promise<string|null>
  if (!toasts) return Promise.resolve(null);
  const type = opts.type || "info";
  const sub = opts.sub || "";
  const iconId = opts.icon || "paste";
  const choices = Array.isArray(opts.choices) ? opts.choices : [];
  if (choices.length === 0) return Promise.resolve(null);

  return new Promise((resolve) => {
    let mo = null;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { mo?.disconnect(); } catch {}
      if (el.isConnected) el.remove();
      resolve(v);
    };

    const el = document.createElement("div");
    el.className = `toast ${type} confirm`;

    const i = document.createElement("div");
    i.className = "ti";
    i.innerHTML = iconUse(iconId);

    const msgEl = document.createElement("div");
    msgEl.className = "msg";
    msgEl.textContent = msg;

    if (sub) {
      const s = document.createElement("div");
      s.className = "sub";
      s.textContent = sub;
      msgEl.appendChild(s);
    }

    const actions = document.createElement("div");
    actions.className = "acts";
    for (const c of choices) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "act" + (c.danger ? " danger" : "");
      b.textContent = c.label || c.value;
      b.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        finish(String(c.value));
      };
      actions.appendChild(b);
    }
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "act";
    cancel.textContent = opts.cancelLabel || "Cancel";
    cancel.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      finish(null);
    };
    actions.appendChild(cancel);
    msgEl.appendChild(actions);

    const x = document.createElement("button");
    x.type = "button";
    x.className = "x";
    x.innerHTML = iconUse("close");
    x.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      finish(null);
    };

    const row = document.createElement("div");
    row.className = "trow";
    row.appendChild(i);
    row.appendChild(msgEl);
    row.appendChild(x);
    el.appendChild(row);

    el.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    };

    toasts.appendChild(el);
    pruneToasts();
    mo = new MutationObserver(() => {
      if (!el.isConnected) finish(null);
    });
    mo.observe(toasts, {childList: true});
  });
}

async function promptUploadConflict(destRel) {
  const target = destRel || "existing file";
  return await choiceToast("File already exists", {
    sub: target,
    icon: "upload",
    type: "info",
    choices: [
      {value: "rename", label: "Keep both"},
      {value: "overwrite", label: "Replace", danger: true},
      {value: "skip", label: "Skip existing"},
    ],
    cancelLabel: "Cancel upload",
  });
}

async function pasteTo(destDirRel) {
  if (!clip || !Array.isArray(clip.paths) || clip.paths.length === 0) return;
  if (clip.base !== BASE) {
    toast("Clipboard is from a different share", {type:"err", dur: 4500});
    return;
  }
  let mode = "rename";
  try {
    const saved = localStorage.getItem("lanpartyPasteMode");
    if (saved) mode = saved;
  } catch {}
  const picked = await choiceToast("Paste options", {
    sub: "Choose conflict behavior",
    icon: "paste",
    type: "info",
    choices: [
      {value: "rename", label: "Keep both"},
      {value: "overwrite", label: "Replace", danger: true},
      {value: "skip", label: "Skip existing"},
    ]
  });
  if (picked) mode = picked;
  if (!mode) return;
  try { localStorage.setItem("lanpartyPasteMode", mode); } catch {}
  try {
    if (clip.op === "cut") {
      await apiMove(clip.paths, destDirRel || "", mode);
      clearClip();
      toast("Moved", {type: "ok", sub: `${clip.paths.length} item(s)`});
    } else {
      await apiCopy(clip.paths, destDirRel || "", mode);
      toast("Copied", {type: "ok", sub: `${clip.paths.length} item(s)`});
    }
    await refresh();
  } catch (e) {
    toast("Paste failed", {type:"err", sub: String(e), dur: 4500});
  }
}

function setWideMode(on) {
  wideMode = Boolean(on);
  try {
    localStorage.setItem("lanpartyWide", wideMode ? "1" : "0");
  } catch {}
  document.body.classList.toggle("wide", wideMode);
  if (opWide) opWide.classList.toggle("active", wideMode);
  // widescreen is a gallery mode now; keep the old side preview hidden
  if (spv) spv.classList.add("hidden");
  // Rebuild the listing so the DOM matches the mode (tiles vs table rows).
  rerenderRows();
}

function initWideMode() {
  let on = false;
  try {
    on = localStorage.getItem("lanpartyWide") === "1";
  } catch {}
  setWideMode(on);
}

async function renderWidePreview(item) {
  if (!spvBody || !spvTitle) return;
  spvBody.innerHTML = "";

  if (!item || !item.path) {
    spvTitle.textContent = "Preview";
    if (spvOpen) spvOpen.setAttribute("href", "#");
    if (spvDownload) spvDownload.removeAttribute("href");
    const d = document.createElement("div");
    d.className = "pvempty";
    d.textContent = "Select a single file to preview.";
    spvBody.appendChild(d);
    return;
  }

  const kind = classify(item);
  const url = fileUrl(item.path);
  spvTitle.textContent = item.path || item.name || "Preview";
  if (spvOpen) spvOpen.href = url;
  if (spvDownload) {
    spvDownload.href = fileUrl(item.path, {dl:true});
    spvDownload.setAttribute("download", item.name || "download");
  }

  if (!isPreviewable(kind) || item.isDir) {
    const d = document.createElement("div");
    d.className = "pvempty";
    d.textContent = item.isDir ? "Folders cannot be previewed." : "No preview available for this file type.";
    spvBody.appendChild(d);
    return;
  }

  if (kind === "image") {
    const img = document.createElement("img");
    img.className = "pv-media pv-img";
    img.src = url;
    img.alt = item.name || "";
    spvBody.appendChild(img);
    return;
  }
  if (kind === "video") {
    const v = document.createElement("video");
    v.className = "pv-media";
    v.controls = true;
    v.playsInline = true;
    v.preload = "metadata";
    v.src = url;
    spvBody.appendChild(v);
    return;
  }
  if (kind === "audio") {
    const a = document.createElement("audio");
    a.className = "pv-media";
    a.controls = true;
    a.preload = "metadata";
    a.src = url;
    spvBody.appendChild(a);
    return;
  }
  if (kind === "pdf") {
    const f = document.createElement("iframe");
    f.className = "pv-media";
    f.src = url;
    f.referrerPolicy = "no-referrer";
    spvBody.appendChild(f);
    return;
  }
  if (kind === "text") {
    const pre = document.createElement("pre");
    pre.className = "pv-pre";
    pre.textContent = "Loading…";
    spvBody.appendChild(pre);
    try {
      const res = await fetch(url, {headers: {"Range": "bytes=0-262143"}});
      if (!res.ok && res.status !== 206) throw new Error(await res.text());
      let txt = await res.text();
      if (txt.length >= 262144) txt += "\n\n…(truncated)…";
      pre.textContent = txt;
    } catch (e) {
      pre.textContent = `Preview failed: ${String(e)}`;
    }
    return;
  }
}

function updateWidePreview() {}

function hideCtx() {
  if (!ctxOpen) return;
  ctx.classList.add("hidden");
  ctx.innerHTML = "";
  ctxOpen = false;
  ctxItem = null;
}

function showCtx(x, y, item) {
  ctxItem = item;
  ctx.innerHTML = "";

  const addSep = () => {
    const s = document.createElement("div");
    s.className = "sep";
    ctx.appendChild(s);
  };
  const addItem = (icon, label, fn, opts = {}) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mi" + (opts.danger ? " danger" : "");
    b.setAttribute("role", "menuitem");
    b.innerHTML = `${iconUse(icon)}<span class="lab">${label}</span>` + (opts.k ? `<span class="k">${opts.k}</span>` : "");
    b.onclick = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      hideCtx();
      try {
        await fn();
      } catch (e) {
        setStatus(String(e));
      }
    };
    ctx.appendChild(b);
  };

  const kind = classify(item);
  const isFile = !item.isDir;
  const isSel = selected.has(item.path);
  const selCount = selected.size;
  const hasMulti = selCount > 1;

  // Primary actions
  if (item.isDir) {
    addItem("open", "Open", async () => setPath(item.path), {k: "Enter"});
    addItem("archive", "Download zip", async () => downloadZip([item.path], item.name || "folder"));
  } else {
    if (isPreviewable(kind)) addItem("eye", "Preview", async () => openPreview(item), {k: "Enter"});
    addItem("open", "Open", async () => window.open(fileUrl(item.path), "_blank"));
    addItem("download", "Download", async () => downloadFile(item.path), {k: "D"});
    if (hasMulti && isSel) addItem("archive", `Download zip (${selCount})`, async () => downloadSelectedZip());
    else addItem("archive", "Download zip", async () => downloadZip([item.path], item.name || "file"));
  }

  addSep();

  // Clipboard ops
  if (selCount > 0) {
    addItem("copy", hasMulti ? `Copy (${selCount})` : "Copy", async () => setClip("copy", [...selected.values()]), {k: "Ctrl+C"});
    addItem("cut", hasMulti ? `Cut (${selCount})` : "Cut", async () => setClip("cut", [...selected.values()]), {k: "Ctrl+X"});
  } else {
    addItem("copy", "Copy", async () => setClip("copy", [item.path]), {k: "Ctrl+C"});
    addItem("cut", "Cut", async () => setClip("cut", [item.path]), {k: "Ctrl+X"});
  }
  const canPaste = clip && Array.isArray(clip.paths) && clip.paths.length > 0 && clip.base === BASE;
  if (canPaste) {
    if (item.isDir) addItem("paste", "Paste into folder", async () => pasteTo(item.path), {k: "Ctrl+V"});
    else addItem("paste", "Paste here", async () => pasteTo(curPath()), {k: "Ctrl+V"});
  }

  addSep();

  if (hasMulti && isSel) {
    addItem("edit", "Bulk rename…", async () => {
      const find = prompt("Bulk rename: find (leave empty to only add prefix/suffix)", "");
      const rep = prompt("Bulk rename: replace with", "");
      const prefix = prompt("Prefix (optional)", "");
      const suffix = prompt("Suffix (optional)", "");
      let ok = 0, fail = 0;
      for (const p of [...selected.values()]) {
        const parts = p.split("/");
        const base = parts.pop() || "";
        const parent = parts.join("/");
        let nb = base;
        if (find != null && find !== "") nb = nb.split(find).join(rep ?? "");
        if (prefix) nb = prefix + nb;
        if (suffix) nb = nb + suffix;
        if (nb === base) continue;
        const dst = parent ? `${parent}/${nb}` : nb;
        try {
          await apiRename(p, dst);
          ok++;
        } catch {
          fail++;
        }
      }
      toast("Bulk rename done", {type: fail ? "err" : "ok", sub: `${ok} ok, ${fail} failed`, dur: fail ? 4500 : 2600});
      await refresh();
    });
    addSep();
  }

  addItem("link", "Copy link", async () => {
    const link = `${location.origin}${fileUrl(item.path)}`;
    const ok = await copyText(link);
    if (ok) toast("Copied link", {type: "ok", sub: link});
    else toast("Copy failed", {type: "err", sub: link, dur: 4500});
  });

  if (!item.isDir && kind === "text") {
    addItem("edit", "Edit…", async () => {
      await openPreview(item, {keepCtx:false});
      pvEdit?.click();
    }, {k: "E"});
  }

  addItem("edit", "Rename…", async () => {
    startRename(item);
    rows.innerHTML = "";
    for (const it of lastList) rows.appendChild(rowFor(it));
    window.requestAnimationFrame(() => {
      const inp = document.querySelector(`input.renin[data-path="${CSS.escape(item.path)}"]`);
      if (inp) {
        inp.focus();
        inp.select();
      }
    });
  });

  addItem("trash", "Delete…", async () => {
    if (hasMulti && isSel) {
      await deletePaths([...selected.values()]);
      return;
    }
    await deletePaths([item.path]);
  }, {danger: true});

  ctx.classList.remove("hidden");
  ctxOpen = true;

  // position within viewport
  ctx.style.left = "0px";
  ctx.style.top = "0px";
  const pad = 8;
  const rect = ctx.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width + pad > window.innerWidth) left = Math.max(pad, window.innerWidth - rect.width - pad);
  if (top + rect.height + pad > window.innerHeight) top = Math.max(pad, window.innerHeight - rect.height - pad);
  ctx.style.left = `${left}px`;
  ctx.style.top = `${top}px`;
}

function showCtxBg(x, y) {
  ctxItem = null;
  ctx.innerHTML = "";

  const addSep = () => {
    const s = document.createElement("div");
    s.className = "sep";
    ctx.appendChild(s);
  };
  const addItem = (icon, label, fn, opts = {}) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mi" + (opts.danger ? " danger" : "");
    b.setAttribute("role", "menuitem");
    b.innerHTML = `${iconUse(icon)}<span class="lab">${label}</span>` + (opts.k ? `<span class="k">${opts.k}</span>` : "");
    b.onclick = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      hideCtx();
      try { await fn(); } catch (e) { setStatus(String(e)); }
    };
    ctx.appendChild(b);
  };

  const canPaste = clip && Array.isArray(clip.paths) && clip.paths.length > 0 && clip.base === BASE;
  if (canPaste) addItem("paste", "Paste", async () => pasteTo(curPath()), {k: "Ctrl+V"});
  addItem("upload", "Upload…", async () => fileEl?.click());
  if (opUploadDir && fileDirEl) addItem("folderup", "Upload folder…", async () => fileDirEl?.click());
  addItem("newfolder", "New folder…", async () => opMkdir?.click?.());
  addItem("text", "New file…", async () => {
    const name = prompt("File name:");
    if (!name) return;
    const dir = curPath();
    const rel = dir ? `${dir}/${name}` : name;
    await openPreview({name, path: rel, isDir: false, mime: "text/plain", size: 0, mtime: 0}, {keepCtx:false});
    pvEdit?.click();
  });

  addSep();
  if (clip) addItem("close", "Clear clipboard", async () => clearClip());

  ctx.classList.remove("hidden");
  ctxOpen = true;

  ctx.style.left = "0px";
  ctx.style.top = "0px";
  const pad = 8;
  const rect = ctx.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width + pad > window.innerWidth) left = Math.max(pad, window.innerWidth - rect.width - pad);
  if (top + rect.height + pad > window.innerHeight) top = Math.max(pad, window.innerHeight - rect.height - pad);
  ctx.style.left = `${left}px`;
  ctx.style.top = `${top}px`;
}

function updateSelectionUI() {
  updateStatusText();
  // enable/disable ops
  const hasSel = selected.size > 0;
  if (opCopy) opCopy.disabled = !hasSel;
  if (opCut) opCut.disabled = !hasSel;
  const canPaste = clip && Array.isArray(clip.paths) && clip.paths.length > 0 && clip.base === BASE;
  if (opPaste) opPaste.disabled = !canPaste;
  if (opZip) opZip.disabled = !hasSel;
  if (opClear) opClear.disabled = !hasSel;
}

function toggleSelected(path, on) {
  if (!path) return;
  if (on === undefined) on = !selected.has(path);
  if (on) selected.add(path);
  else selected.delete(path);
  updateSelectionUI();
}

function setSelection(paths) {
  selected = new Set((paths || []).filter(Boolean));
  updateSelectionUI();
}

function confirmToast(msg, opts = {}) {
  // Non-blocking confirmation UI using the toast system.
  // Returns Promise<boolean>.
  if (!toasts) return Promise.resolve(false);

  const type = opts.type || "err"; // err|ok|info
  const sub = opts.sub || "";
  const okLabel = opts.okLabel || "Delete";
  const cancelLabel = opts.cancelLabel || "Cancel";
  const iconId = opts.icon || "trash";

  return new Promise((resolve) => {
    let mo = null;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { mo?.disconnect(); } catch {}
      if (el.isConnected) el.remove();
      resolve(v);
    };

    const el = document.createElement("div");
    el.className = `toast ${type} confirm`;

    const i = document.createElement("div");
    i.className = "ti";
    i.innerHTML = iconUse(iconId);

    const msgEl = document.createElement("div");
    msgEl.className = "msg";
    msgEl.textContent = msg;

    if (sub) {
      const s = document.createElement("div");
      s.className = "sub";
      s.textContent = sub;
      msgEl.appendChild(s);
    }

    const actions = document.createElement("div");
    actions.className = "acts";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "act";
    cancel.textContent = cancelLabel;
    cancel.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };

    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "act danger";
    ok.textContent = okLabel;
    ok.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      finish(true);
    };

    actions.appendChild(cancel);
    actions.appendChild(ok);
    msgEl.appendChild(actions);

    const x = document.createElement("button");
    x.type = "button";
    x.className = "x";
    x.innerHTML = iconUse("close");
    x.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };

    const row = document.createElement("div");
    row.className = "trow";
    row.appendChild(i);
    row.appendChild(msgEl);
    row.appendChild(x);
    el.appendChild(row);

    // Don't auto-dismiss on click for confirmations.
    el.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    };

    toasts.appendChild(el);
    // If this toast gets removed externally (e.g. pruned due to >4 toasts),
    // resolve as "cancel" so callers don't hang indefinitely.
    mo = new MutationObserver(() => {
      if (!el.isConnected) finish(false);
    });
    try { mo.observe(toasts, {childList: true}); } catch {}
    pruneToasts();

    // Focus the destructive action for quick keyboard flow.
    window.setTimeout(() => {
      ok.focus();
    }, 0);
  });
}

async function deletePaths(paths) {
  paths = (paths || []).filter(Boolean);
  if (!paths.length) return;
  const msg = paths.length === 1 ? `Delete “${paths[0]}”?` : `Delete ${paths.length} selected items?`;
  const confirmed = await confirmToast(msg, {sub: "This cannot be undone.", okLabel: "Delete", cancelLabel: "Cancel", type: "err", icon: "trash"});
  if (!confirmed) return;
  let okCount = 0;
  let failCount = 0;
  let lastErr = "";
  for (const p of paths) {
    try {
      await apiDelete(p);
      okCount++;
    } catch (e) {
      failCount++;
      lastErr = String(e);
    }
  }
  selected = new Set();
  updateSelectionUI();
  await refresh();
  if (failCount === 0) {
    toast("Deleted", {type: "ok", sub: `${okCount} item(s)`});
  } else {
    const sub = lastErr ? `${okCount} ok, ${failCount} failed · ${lastErr}` : `${okCount} ok, ${failCount} failed`;
    toast("Delete completed with errors", {type: "err", sub, dur: 4500});
  }
}

function startRename(item) {
  if (!item || !item.path) return;
  ren = {path: item.path, value: item.name || ""};
  renFocus = item.path;
}

function cancelRename() {
  ren = null;
  renFocus = null;
}

async function commitRename(item, newName) {
  if (!item || !item.path) return;
  const cur = item.name || "";
  const next = (newName || "").trim();
  if (!next || next === cur) {
    cancelRename();
    return;
  }
  if (next.includes("/") || next.includes("\\")) {
    toast("Invalid name", {type: "err", sub: "Name cannot contain '/' or '\\\\'"});
    return;
  }
  const parts = item.path.split("/").filter(Boolean);
  parts.pop();
  const parent = parts.join("/");
  const to = parent ? `${parent}/${next}` : next;
  try {
    await apiRename(item.path, to);
    toast("Renamed", {type: "ok", sub: `${cur} → ${next}`});
  } catch (e) {
    toast("Rename failed", {type: "err", sub: String(e), dur: 4500});
  } finally {
    cancelRename();
    await refresh();
  }
}

function selectionRange(a, b) {
  if (a < 0 || b < 0) return [];
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const out = [];
  for (let i = lo; i <= hi; i++) {
    const it = lastList[i];
    if (!it || !it.path) continue;
    out.push(it.path);
  }
  return out;
}

function downloadSelectedZip() {
  const paths = [...selected.values()];
  if (paths.length === 0) return;
  const rel = curPath();
  const base = rel ? rel.split("/").filter(Boolean).slice(-1)[0] : "download";
  const name = `${base}-${paths.length} items`;
  downloadZip(paths, name);
}

function downloadZip(paths, name) {
  if (!paths || paths.length === 0) return;
  const form = document.createElement("form");
  form.method = "POST";
  form.action = `${BASE}/api/zip`;
  form.target = "dlframe";
  form.style.display = "none";

  const inName = document.createElement("input");
  inName.type = "hidden";
  inName.name = "name";
  inName.value = name || "download";
  form.appendChild(inName);

  for (const p of paths) {
    const inp = document.createElement("input");
    inp.type = "hidden";
    inp.name = "paths";
    inp.value = p;
    form.appendChild(inp);
  }
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

function downloadFile(rel) {
  const url = fileUrl(rel, {dl:true});
  const a = document.createElement("a");
  a.href = url;
  a.target = "dlframe";
  a.rel = "noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function apiList(rel) {
  const res = await fetch(`${BASE}/api/list?path=${encodeURIComponent(rel || "")}`);
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function loadDirs(rel) {
  rel = rel || "";
  const cached = treeCache.get(rel);
  if (cached && cached.loaded) return cached.dirs;
  const data = await apiList(rel);
  const dirs = (data.items || []).filter((it) => it.isDir).map((it) => ({name: it.name, path: it.path}));
  dirs.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  treeCache.set(rel, {loaded: true, dirs});
  return dirs;
}

function ensurePathOpen(rel) {
  const parts = (rel || "").split("/").filter(Boolean);
  let acc = "";
  treeOpen.add(""); // root
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    treeOpen.add(acc);
  }
}

function renderTreeNode(rel, depth, activeRel) {
  const wrap = document.createElement("div");
  const row = document.createElement("div");
  row.className = "trow" + (rel === activeRel ? " active" : "");
  // indent guides are rendered explicitly (see .tind)

  const ind = document.createElement("div");
  ind.className = "tind";
  // For each depth level: draw a vertical guide aligned to the chevron column.
  for (let k = 0; k < depth; k++) {
    const s = document.createElement("span");
    s.className = "v";
    ind.appendChild(s);
  }

  const tw = document.createElement("button");
  tw.type = "button";
  tw.className = "tw";
  tw.innerHTML = iconUse(treeOpen.has(rel) ? "chevd" : "chevr");
  tw.onclick = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (treeOpen.has(rel)) treeOpen.delete(rel);
    else treeOpen.add(rel);
    // lazy-load children when expanding
    if (treeOpen.has(rel)) {
      try { await loadDirs(rel); } catch { /* ignore */ }
    }
    renderTree();
  };

  const fi = document.createElement("div");
  fi.className = "fi";
  fi.innerHTML = iconUse("folder");

  const lab = document.createElement("div");
  lab.className = "lab";
  lab.textContent = rel === "" ? "/" : rel.split("/").slice(-1)[0];

  row.onclick = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    setPath(rel);
  };

  row.appendChild(ind);
  row.appendChild(tw);
  row.appendChild(fi);
  row.appendChild(lab);
  wrap.appendChild(row);

  return wrap;
}

async function renderTree() {
  if (!treeEl) return;
  const activeRel = curPath();
  ensurePathOpen(activeRel);

  treeEl.innerHTML = "";
  // root always shown
  const rootNode = renderTreeNode("", 0, activeRel);
  treeEl.appendChild(rootNode);

  const renderChildren = async (parentRel, depth) => {
    if (!treeOpen.has(parentRel)) return;
    let dirs = [];
    try {
      dirs = await loadDirs(parentRel);
    } catch {
      return;
    }
    for (const d of dirs) {
      const node = renderTreeNode(d.path, depth, activeRel);
      treeEl.appendChild(node);
      await renderChildren(d.path, depth + 1);
    }
  };

  await renderChildren("", 1);
}

async function apiSearch(baseRel, q) {
  const res = await fetch(`${BASE}/api/search?path=${encodeURIComponent(baseRel || "")}&q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiMkdir(rel) {
  const res = await fetch(`${BASE}/api/mkdir`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({path: rel})
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiRename(fromRel, toRel) {
  const res = await fetch(`${BASE}/api/rename`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({from: fromRel, to: toRel})
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiDelete(rel) {
  const res = await fetch(`${BASE}/api/delete`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({path: rel})
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiUploadCreate(destRel, size) {
  const res = await fetch(`${BASE}/api/uploads?path=${encodeURIComponent(destRel)}&size=${encodeURIComponent(size)}`, {method:"POST"});
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiUploadPatch(id, start, end, total, blob) {
  const res = await fetch(`${BASE}/api/uploads/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {"Content-Range": `bytes ${start}-${end}/${total}`},
    body: blob
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiUploadFinish(id) {
  const res = await fetch(`${BASE}/api/uploads/${encodeURIComponent(id)}/finish`, {method:"POST"});
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiUploadCreate2(destRel, size, mode, signal) {
  const url = `${BASE}/api/uploads?path=${encodeURIComponent(destRel)}&size=${encodeURIComponent(size)}&mode=${encodeURIComponent(mode || "overwrite")}`;
  const res = await fetch(url, {method:"POST", signal});
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(body || res.statusText || "upload create failed");
    err.status = res.status;
    throw err;
  }
  return await res.json();
}

async function apiUploadGet(id, signal) {
  const res = await fetch(`${BASE}/api/uploads/${encodeURIComponent(id)}`, {method:"GET", signal});
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiUploadPatch2(id, start, end, total, blob, signal) {
  const res = await fetch(`${BASE}/api/uploads/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {"Content-Range": `bytes ${start}-${end}/${total}`},
    body: blob,
    signal,
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiUploadFinish2(id, signal) {
  const res = await fetch(`${BASE}/api/uploads/${encodeURIComponent(id)}/finish`, {method:"POST", signal});
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiUploadCancel(id) {
  const res = await fetch(`${BASE}/api/uploads/${encodeURIComponent(id)}`, {method:"DELETE"});
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiWrite(rel, content, mode = "overwrite") {
  const res = await fetch(`${BASE}/api/write`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({path: rel, content, mode}),
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiCopy(paths, destDir, mode = "rename") {
  const res = await fetch(`${BASE}/api/copy`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({paths, destDir, mode}),
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiMove(paths, destDir, mode = "rename") {
  const res = await fetch(`${BASE}/api/move`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({paths, destDir, mode}),
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiZipList(rel) {
  const res = await fetch(`${BASE}/api/zipls?path=${encodeURIComponent(rel || "")}`);
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

function zipEntryUrl(zipRel, entry) {
  return `${BASE}/api/zipget?path=${encodeURIComponent(zipRel || "")}&entry=${encodeURIComponent(entry || "")}`;
}

function renderCrumbs(rel) {
  crumbs.innerHTML = "";
  const parts = (rel || "").split("/").filter(Boolean);

  const mkCrumb = (label, targetRel, isCurrent) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "crumb" + (isCurrent ? " current" : "");
    b.textContent = label;
    b.onclick = () => setPath(targetRel);
    return b;
  };
  const mkSep = () => {
    const s = document.createElement("span");
    s.className = "sep";
    s.textContent = "/";
    return s;
  };

  // Render as a real path: /src/foo/bar (root clickable).
  crumbs.appendChild(mkCrumb("/", "", parts.length === 0));
  if (parts.length === 0) return;

  // First segment goes immediately after "/" so we don't get "/ / src".
  let acc = parts[0];
  crumbs.appendChild(mkCrumb(parts[0], acc, parts.length === 1));

  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    acc = `${acc}/${p}`;
    crumbs.appendChild(mkSep());
    crumbs.appendChild(mkCrumb(p, acc, i === parts.length - 1));
  }
}

function openModal() {
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

function closeModal() {
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  pvTitle.textContent = "";
  pvBody.innerHTML = "";
  pvOpen.removeAttribute("href");
  pvDownload.removeAttribute("href");
  pvEditState = null;
  if (pvEdit) pvEdit.disabled = true;
  if (pvSave) { pvSave.disabled = true; pvSave.innerHTML = `${iconUse("check")} Save`; }
  pvCtx = null;
  if (pvSlideTimer) {
    try { window.clearInterval(pvSlideTimer); } catch {}
    pvSlideTimer = null;
  }
  if (pvSlide) pvSlide.innerHTML = iconUse("play");
}

function previewableItemsInView() {
  return (lastList || []).filter((it) => it && it.path && !it.isDir && isPreviewable(classify(it)));
}

function setPvCtxForItem(item) {
  const items = previewableItemsInView();
  const idx = items.findIndex((x) => x.path === item.path);
  pvCtx = {items, idx: Math.max(0, idx)};
  updatePvNav();
}

function updatePvNav() {
  if (!pvPrev || !pvNext || !pvSlide) return;
  const ok = pvCtx && pvCtx.items && pvCtx.items.length > 0;
  pvPrev.disabled = !ok || pvCtx.idx <= 0;
  pvNext.disabled = !ok || pvCtx.idx >= (pvCtx.items.length - 1);
  // slideshow only makes sense for images
  const cur = ok ? pvCtx.items[pvCtx.idx] : null;
  const isImg = cur && classify(cur) === "image";
  pvSlide.disabled = !isImg;
  const isTxt = cur && classify(cur) === "text";
  if (pvEdit) pvEdit.disabled = !isTxt;
  if (pvSave && (!pvEditState || pvEditState.path !== (cur?.path || ""))) pvSave.disabled = true;
}

async function openPreviewAt(idx) {
  if (!pvCtx || !pvCtx.items) return;
  const i = Math.max(0, Math.min(pvCtx.items.length - 1, idx));
  pvCtx.idx = i;
  updatePvNav();
  await openPreview(pvCtx.items[i], {keepCtx:true});
}

async function openPreview(item, opts = {}) {
  const kind = classify(item);
  const url = fileUrl(item.path);
  pvTitle.textContent = item.path || item.name || "";
  pvOpen.href = url;
  pvDownload.href = fileUrl(item.path, {dl:true});
  pvDownload.setAttribute("download", item.name || "download");

  pvBody.innerHTML = "";
  openModal();
  if (!opts.keepCtx) setPvCtxForItem(item);

  if (kind === "image") {
    const img = document.createElement("img");
    img.className = "pv-media pv-img";
    img.src = url;
    img.alt = item.name || "";
    pvBody.appendChild(img);
    return;
  }
  if (kind === "video") {
    const v = document.createElement("video");
    v.className = "pv-media";
    v.controls = true;
    v.autoplay = true;
    v.playsInline = true;
    v.src = url;
    pvBody.appendChild(v);
    return;
  }
  if (kind === "audio") {
    const a = document.createElement("audio");
    a.className = "pv-media";
    a.controls = true;
    a.autoplay = true;
    a.src = url;
    pvBody.appendChild(a);
    // simple playlist: advance to next audio in view
    a.addEventListener("ended", () => {
      if (!pvCtx) return;
      for (let j = pvCtx.idx + 1; j < pvCtx.items.length; j++) {
        if (classify(pvCtx.items[j]) === "audio") {
          openPreviewAt(j);
          break;
        }
      }
    });
    return;
  }
  if (kind === "pdf") {
    const f = document.createElement("iframe");
    f.className = "pv-media";
    f.src = url;
    f.referrerPolicy = "no-referrer";
    pvBody.appendChild(f);
    return;
  }
  if (kind === "text") {
    const pre = document.createElement("pre");
    pre.className = "pv-pre";
    pre.textContent = "Loading…";
    pvBody.appendChild(pre);
    pvEditState = {path: item.path, name: item.name, content: "", dirty: false};
    if (pvEdit) pvEdit.disabled = false;
    if (pvSave) pvSave.disabled = true;
    try {
      // Avoid loading huge files: fetch only the first 256KiB via Range.
      const res = await fetch(url, {headers: {"Range": "bytes=0-262143"}});
      if (!res.ok && res.status !== 206) throw new Error(await res.text());
      let txt = await res.text();
      if (txt.length >= 262144) txt += "\n\n…(truncated)…";
      pre.textContent = txt;
      pvEditState.content = txt.replace(/\n\n…\(truncated\)…\s*$/, "");
    } catch (e) {
      pre.textContent = `Preview failed: ${String(e)}`;
    }
    return;
  }

  if (kind === "archive") {
    const name = String(item.name || "");
    const ext = name.toLowerCase().includes(".") ? name.toLowerCase().slice(name.toLowerCase().lastIndexOf(".")) : "";
    const box = document.createElement("div");
    box.className = "pv-zip";
    box.textContent = "Loading…";
    pvBody.appendChild(box);

    if (ext !== ".zip") {
      box.textContent = "Archive preview is currently supported for .zip files only.";
      return;
    }

    try {
      const data = await apiZipList(item.path);
      const entries = data.entries || [];
      box.innerHTML = "";
      let prefix = "";

      const head = document.createElement("div");
      head.className = "zhead";
      box.appendChild(head);

      const t = document.createElement("table");
      t.className = "ztab";
      const thead = document.createElement("thead");
      thead.innerHTML = "<tr><th>Name</th><th class='right'>Size</th><th class='right'>Modified</th><th></th></tr>";
      t.appendChild(thead);
      const tb = document.createElement("tbody");
      t.appendChild(tb);
      box.appendChild(t);

      const renderZip = () => {
        tb.innerHTML = "";
        head.innerHTML = "";

        // breadcrumb
        const bc = document.createElement("div");
        bc.className = "zbc";
        const mk = (label, pfx) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "crumb";
          b.textContent = label;
          b.onclick = () => { prefix = pfx; renderZip(); };
          return b;
        };
        bc.appendChild(mk("/", ""));
        if (prefix) {
          const parts = prefix.split("/").filter(Boolean);
          let acc = "";
          for (const part of parts) {
            acc += part + "/";
            const sep = document.createElement("span");
            sep.className = "sep";
            sep.textContent = "/";
            bc.appendChild(sep);
            bc.appendChild(mk(part, acc));
          }
        }
        head.appendChild(bc);

        const meta = document.createElement("div");
        meta.className = "zmeta";
        meta.textContent = `${entries.length}${data.truncated ? "+" : ""} entries`;
        head.appendChild(meta);

        // collect direct children
        const dirs = new Set();
        const files = [];
        for (const e of entries) {
          const nm = String(e.name || "");
          if (!nm.startsWith(prefix)) continue;
          const rest = nm.slice(prefix.length);
          if (!rest) continue;
          const parts = rest.split("/");
          const first = parts[0];
          if (!first) continue;
          if (parts.length > 1 || String(e.isDir) === "true" || nm.endsWith("/")) {
            dirs.add(first);
          } else {
            files.push({...e, _disp: first});
          }
        }
        const dirList = [...dirs.values()].sort((a,b)=>a.localeCompare(b));
        files.sort((a,b)=>String(a._disp||"").localeCompare(String(b._disp||"")));

        if (prefix) {
          const up = document.createElement("tr");
          const td = document.createElement("td");
          td.className = "zname";
          const b = document.createElement("button");
          b.type = "button";
          b.className = "subpath";
          b.textContent = "..";
          b.onclick = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const parts = prefix.split("/").filter(Boolean);
            parts.pop();
            prefix = parts.length ? (parts.join("/") + "/") : "";
            renderZip();
          };
          td.appendChild(b);
          up.appendChild(td);
          up.innerHTML += "<td></td><td></td><td></td>";
          tb.appendChild(up);
        }

        for (const d of dirList) {
          const tr = document.createElement("tr");
          const tdName = document.createElement("td");
          tdName.className = "zname";
          const b = document.createElement("button");
          b.type = "button";
          b.className = "subpath";
          b.innerHTML = `${iconUse("folder")} ${d}/`;
          b.onclick = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            prefix = prefix + d + "/";
            renderZip();
          };
          tdName.appendChild(b);
          const tdSize = document.createElement("td"); tdSize.className = "right"; tdSize.textContent = "";
          const tdMt = document.createElement("td"); tdMt.className = "right"; tdMt.textContent = "";
          const tdAct = document.createElement("td"); tdAct.className = "right"; tdAct.textContent = "";
          tr.appendChild(tdName); tr.appendChild(tdSize); tr.appendChild(tdMt); tr.appendChild(tdAct);
          tb.appendChild(tr);
        }

        for (const e of files) {
          const tr = document.createElement("tr");
          const tdName = document.createElement("td");
          tdName.className = "zname";
          tdName.textContent = e._disp || e.name;
          const tdSize = document.createElement("td");
          tdSize.className = "right";
          tdSize.textContent = fmtSize(Number(e.size || 0));
          const tdMt = document.createElement("td");
          tdMt.className = "right";
          tdMt.textContent = e.mtime ? fmtTime(Number(e.mtime)) : "";
          const tdAct = document.createElement("td");
          tdAct.className = "right";
          const a = document.createElement("a");
          a.className = "btn ghost zdl";
          a.href = zipEntryUrl(item.path, prefix + (e._disp || e.name));
          a.target = "dlframe";
          a.rel = "noreferrer";
          a.innerHTML = `${iconUse("download")} Download`;
          tdAct.appendChild(a);
          tr.appendChild(tdName); tr.appendChild(tdSize); tr.appendChild(tdMt); tr.appendChild(tdAct);
          tb.appendChild(tr);
        }
      };

      renderZip();
    } catch (e) {
      box.textContent = `Archive preview failed: ${String(e)}`;
    }
    return;
  }
}

function rowFor(item) {
  const view = parseView();
  const inSearch = Boolean(view.q);
  if (wideMode && !inSearch) {
    return rowForTile(item);
  }

  const el = document.createElement("div");
  el.className = "row";

  const kind = classify(item);

  const namecell = document.createElement("div");
  namecell.className = "namecell";

  const ico = document.createElement("div");
  ico.className = "ico";
  if (item.thumb && (kind === "image" || kind === "text")) {
    ico.classList.add("thumb");
    ico.style.backgroundImage = `url("${item.thumb}")`;
  } else {
    ico.innerHTML = iconUse(kind);
  }
  if (item.isLink) {
    const b = document.createElement("div");
    b.className = "lnkbad";
    b.innerHTML = iconUse("link");
    if (item.linkTo) b.title = `Link → ${item.linkTo}`;
    ico.appendChild(b);
  }

  let fname;
  if (ren && ren.path === item.path) {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "renin";
    inp.value = ren.value || item.name || "";
    inp.setAttribute("data-path", item.path);
    inp.oninput = () => { if (ren && ren.path === item.path) ren.value = inp.value; };
    inp.onkeydown = async (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        cancelRename();
        rows.innerHTML = "";
        for (const it of lastList) rows.appendChild(rowFor(it));
        return;
      }
      if (ev.key === "Enter") {
        ev.preventDefault();
        ev.stopPropagation();
        await commitRename(item, inp.value);
      }
    };
    inp.onblur = () => {
      cancelRename();
      rows.innerHTML = "";
      for (const it of lastList) rows.appendChild(rowFor(it));
    };
    fname = inp;
  } else {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "fname openname";
    b.textContent = item.name;
    b.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      hideCtx();
      if (item.isDir) {
        setPath(item.path);
        return;
      }
      if (isPreviewable(kind)) openPreview(item);
      else window.open(fileUrl(item.path), "_blank");
    };
    fname = b;
  }

  namecell.appendChild(ico);
  const namewrap = document.createElement("div");
  namewrap.className = "namewrap";
  namewrap.appendChild(fname);
  if (inSearch && !ren && item.path) {
    const parts = item.path.split("/").filter(Boolean);
    parts.pop();
    const parent = parts.join("/");
    const loc = document.createElement("button");
    loc.type = "button";
    loc.className = "subpath";
    loc.textContent = parent ? `/${parent}` : "/";
    loc.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      setView(parent, "");
    };
    namewrap.appendChild(loc);
  }
  namecell.appendChild(namewrap);

  const size = document.createElement("div");
  size.className = "meta right";
  size.textContent = item.isDir ? "" : fmtSize(item.size);

  const mtime = document.createElement("div");
  mtime.className = "meta right";
  mtime.textContent = fmtTime(item.mtime);

  el.appendChild(namecell);
  el.appendChild(size);
  el.appendChild(mtime);

  const isSel = selected.has(item.path);
  if (isSel) {
    el.classList.add("selected");
    ico.classList.add("sel");
  }

  el.oncontextmenu = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    hideCtx();

    // Desktop-like: right-click selects the item (if not already selected)
    if (!selected.has(item.path)) {
      setSelection([item.path]);
      rows.innerHTML = "";
      for (const it of lastList) rows.appendChild(rowFor(it));
    }
    const idx = lastList.findIndex((x) => x.path === item.path);
    if (idx >= 0) lastClickedIndex = idx;
    showCtx(ev.clientX, ev.clientY, item);
  };

  // Prevent browser text selection on shift-click drag, without breaking the name button.
  el.onmousedown = (ev) => {
    if (ev.button !== 0) return; // left click only
    const t = ev.target;
    if (t && t.closest && (t.closest(".openname") || t.closest(".renin"))) return;
    ev.preventDefault();
  };

  el.onclick = (ev) => {
    hideCtx();
    const idx = lastList.findIndex((x) => x.path === item.path);
    const prev = lastClickedIndex;
    if (idx >= 0) lastClickedIndex = idx;

    if (ev.shiftKey && prev >= 0 && idx >= 0) {
      setSelection(selectionRange(prev, idx));
    } else if (ev.ctrlKey || ev.metaKey) {
      toggleSelected(item.path);
    } else {
      // Normal click:
      // - if only this item is selected, toggle it off
      // - else select just this item
      if (selected.has(item.path)) {
        if (selected.size === 1) setSelection([]);
        else setSelection([item.path]);
      } else {
        setSelection([item.path]);
      }
    }

    rows.innerHTML = "";
    for (const it of lastList) rows.appendChild(rowFor(it));
  };

  return el;
}

function rowForTile(item) {
  const el = document.createElement("div");
  el.className = "row";

  const kind = classify(item);

  const prev = document.createElement("div");
  prev.className = "tileprev";
  if (kind === "image" && item.thumb) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = item.name || "";
    img.src = thumbUrl(item.thumb, 768);
    prev.appendChild(img);
  } else if (kind === "text" && item.thumb) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = item.name || "";
    img.src = thumbUrl(item.thumb, 768);
    prev.appendChild(img);
  } else if (kind === "image") {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = item.name || "";
    img.src = fileUrl(item.path);
    prev.appendChild(img);
  } else if (kind === "video") {
    const v = document.createElement("video");
    v.className = "tilevid";
    v.muted = true;
    v.playsInline = true;
    v.preload = "metadata";
    v.controls = false;
    // Lazy-load videos to avoid hammering the network for large folders.
    lazyObserve(v, fileUrl(item.path));
    // Subtle hover preview (muted) when loaded.
    let hov = false;
    const ensureLoaded = () => {
      if (!v.src && v.dataset && v.dataset.src) {
        v.src = v.dataset.src;
        try { v.load(); } catch {}
      }
    };
    const safePlay = () => {
      try {
        ensureLoaded();
        const p = v.play();
        if (p && typeof p.catch === "function") p.catch(() => {}); // swallow AbortError, etc
      } catch {}
    };
    const safeStop = () => {
      try { v.pause(); } catch {}
      try { v.currentTime = 0; } catch {}
    };
    v.addEventListener("mouseenter", () => {
      hov = true;
      safePlay();
    });
    v.addEventListener("mouseleave", () => {
      hov = false;
      safeStop();
    });
    v.addEventListener("loadeddata", () => {
      if (hov) safePlay();
    });
    prev.appendChild(v);
  } else if (item.isDir) {
    prev.innerHTML = iconUse("folder");
  } else {
    prev.innerHTML = iconUse(kind);
  }
  if (item.isLink) {
    const b = document.createElement("div");
    b.className = "lnkbad";
    b.innerHTML = iconUse("link");
    if (item.linkTo) b.title = `Link → ${item.linkTo}`;
    prev.appendChild(b);
  }

  const namecell = document.createElement("div");
  namecell.className = "namecell";

  let fname;
  if (ren && ren.path === item.path) {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "renin";
    inp.value = ren.value || item.name || "";
    inp.setAttribute("data-path", item.path);
    inp.oninput = () => { if (ren && ren.path === item.path) ren.value = inp.value; };
    inp.onkeydown = async (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        cancelRename();
        rows.innerHTML = "";
        for (const it of lastList) rows.appendChild(rowFor(it));
        return;
      }
      if (ev.key === "Enter") {
        ev.preventDefault();
        ev.stopPropagation();
        await commitRename(item, inp.value);
      }
    };
    inp.onblur = () => {
      cancelRename();
      rows.innerHTML = "";
      for (const it of lastList) rows.appendChild(rowFor(it));
    };
    fname = inp;
  } else {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "fname openname";
    b.textContent = item.name;
    b.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      hideCtx();
      if (item.isDir) {
        setPath(item.path);
        return;
      }
      if (isPreviewable(kind)) openPreview(item);
      else window.open(fileUrl(item.path), "_blank");
    };
    fname = b;
  }

  const namewrap = document.createElement("div");
  namewrap.className = "namewrap";
  namewrap.appendChild(fname);

  const meta = document.createElement("div");
  meta.className = "tilemeta";
  if (item.isDir) {
    meta.textContent = fmtTime(item.mtime);
  } else {
    meta.textContent = `${fmtSize(item.size)} · ${fmtTime(item.mtime)}`;
  }
  namewrap.appendChild(meta);

  namecell.appendChild(namewrap);

  el.appendChild(prev);
  el.appendChild(namecell);

  if (selected.has(item.path)) el.classList.add("selected");

  el.oncontextmenu = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    hideCtx();

    // Desktop-like: right-click selects the item (if not already selected)
    if (!selected.has(item.path)) {
      setSelection([item.path]);
      rows.innerHTML = "";
      for (const it of lastList) rows.appendChild(rowFor(it));
    }
    const idx = lastList.findIndex((x) => x.path === item.path);
    if (idx >= 0) lastClickedIndex = idx;
    showCtx(ev.clientX, ev.clientY, item);
  };

  el.onmousedown = (ev) => {
    if (ev.button !== 0) return;
    const t = ev.target;
    if (t && t.closest && (t.closest(".openname") || t.closest(".renin"))) return;
    ev.preventDefault();
  };

  el.onclick = (ev) => {
    hideCtx();
    const idx = lastList.findIndex((x) => x.path === item.path);
    const prevIdx = lastClickedIndex;
    if (idx >= 0) lastClickedIndex = idx;

    if (ev.shiftKey && prevIdx >= 0 && idx >= 0) {
      setSelection(selectionRange(prevIdx, idx));
    } else if (ev.ctrlKey || ev.metaKey) {
      toggleSelected(item.path);
    } else {
      if (selected.has(item.path)) {
        if (selected.size === 1) setSelection([]);
        else setSelection([item.path]);
      } else {
        setSelection([item.path]);
      }
    }

    rows.innerHTML = "";
    for (const it of lastList) rows.appendChild(rowFor(it));
  };

  return el;
}

function clearReadme() {
  readmeEl.classList.add("hidden");
  readmeBody.innerHTML = "";
  readmeOpen.removeAttribute("href");
}

function escapeHTML(s) {
  return (s || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
}

function normalizeRelPath(p) {
  p = (p || "").replaceAll("\\", "/");
  const parts = p.split("/").filter((x) => x.length > 0);
  const out = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      if (out.length) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

function resolveMdUrl(baseReadmeRel, url) {
  url = (url || "").trim();
  if (!url) return url;
  if (url.startsWith("#")) return url;

  // disallow javascript: URLs
  const low = url.toLowerCase();
  if (low.startsWith("javascript:") || low.startsWith("vbscript:")) return "#";

  // external scheme
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return url;

  // absolute within share
  if (url.startsWith("/")) return fileUrl(url.slice(1));

  const baseDir = (baseReadmeRel || "").split("/").slice(0, -1).join("/");
  return fileUrl(normalizeRelPath(baseDir ? `${baseDir}/${url}` : url));
}

function splitTableRow(line) {
  // Very small GFM table splitter (no escaped pipes support).
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

function parseTaskPrefix(s) {
  const m = s.match(/^\[( |x|X)\]\s+(.*)$/);
  if (!m) return null;
  return {checked: m[1].toLowerCase() === "x", rest: m[2] || ""};
}

function renderInline(container, text, baseReadmeRel) {
  // Safe inline GFM-ish: code, links, images, bold/italic, strikethrough, autolinks, bare http(s).
  let i = 0;
  const pushText = (t) => { if (t) container.appendChild(document.createTextNode(t)); };

  const findNext = (from) => {
    const candidates = [];
    const add = (type, idx) => { if (idx >= 0) candidates.push({type, idx}); };
    add("code", text.indexOf("`", from));
    add("img", text.indexOf("![", from));
    add("link", text.indexOf("[", from));
    add("bold", text.indexOf("**", from));
    add("strike", text.indexOf("~~", from));
    add("star", text.indexOf("*", from));
    add("under", text.indexOf("_", from));
    add("autol", text.indexOf("<http", from));
    add("http", text.indexOf("http://", from));
    add("https", text.indexOf("https://", from));
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.idx - b.idx);
    return candidates[0];
  };

  while (i < text.length) {
    const n = findNext(i);
    if (!n) {
      pushText(text.slice(i));
      break;
    }
    if (n.idx > i) {
      pushText(text.slice(i, n.idx));
      i = n.idx;
    }

    // inline code
    if (n.type === "code" && text[i] === "`") {
      const j = text.indexOf("`", i + 1);
      if (j > i) {
        const code = document.createElement("code");
        code.textContent = text.slice(i + 1, j);
        container.appendChild(code);
        i = j + 1;
        continue;
      }
    }

    // autolink <http...>
    if (n.type === "autol" && text[i] === "<") {
      const j = text.indexOf(">", i + 1);
      if (j > i) {
        const url = text.slice(i + 1, j);
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noreferrer";
        a.textContent = url;
        container.appendChild(a);
        i = j + 1;
        continue;
      }
    }

    // image ![alt](url)
    if (n.type === "img" && text.startsWith("![", i)) {
      const j = text.indexOf("]", i + 2);
      const k = j >= 0 ? text.indexOf("(", j + 1) : -1;
      const l = k >= 0 ? text.indexOf(")", k + 1) : -1;
      if (j > i && k === j + 1 && l > k) {
        const alt = text.slice(i + 2, j);
        const url = text.slice(k + 1, l);
        const img = document.createElement("img");
        img.alt = alt;
        img.loading = "lazy";
        img.src = resolveMdUrl(baseReadmeRel, url);
        container.appendChild(img);
        i = l + 1;
        continue;
      }
    }

    // link [label](url)
    if ((n.type === "link" || n.type === "img") && text[i] === "[") {
      const j = text.indexOf("]", i + 1);
      const k = j >= 0 ? text.indexOf("(", j + 1) : -1;
      const l = k >= 0 ? text.indexOf(")", k + 1) : -1;
      if (j > i && k === j + 1 && l > k) {
        const label = text.slice(i + 1, j);
        const url = text.slice(k + 1, l);
        const a = document.createElement("a");
        a.href = resolveMdUrl(baseReadmeRel, url);
        if (!a.href.startsWith(location.origin)) {
          a.target = "_blank";
          a.rel = "noreferrer";
        }
        a.textContent = label || url;
        container.appendChild(a);
        i = l + 1;
        continue;
      }
    }

    // bold **x**
    if (n.type === "bold" && text.startsWith("**", i)) {
      const j = text.indexOf("**", i + 2);
      if (j > i) {
        const b = document.createElement("strong");
        renderInline(b, text.slice(i + 2, j), baseReadmeRel);
        container.appendChild(b);
        i = j + 2;
        continue;
      }
    }

    // strikethrough ~~x~~
    if (n.type === "strike" && text.startsWith("~~", i)) {
      const j = text.indexOf("~~", i + 2);
      if (j > i) {
        const s = document.createElement("del");
        renderInline(s, text.slice(i + 2, j), baseReadmeRel);
        container.appendChild(s);
        i = j + 2;
        continue;
      }
    }

    // italic *x* or _x_
    if ((n.type === "star" && text[i] === "*") || (n.type === "under" && text[i] === "_")) {
      const ch = text[i];
      const j = text.indexOf(ch, i + 1);
      if (j > i) {
        const em = document.createElement("em");
        renderInline(em, text.slice(i + 1, j), baseReadmeRel);
        container.appendChild(em);
        i = j + 1;
        continue;
      }
    }

    // bare url
    if (n.type === "http" || n.type === "https") {
      const m = text.slice(i).match(/^(https?:\/\/[^\s<]+[^<\s\)\]\}.,!?:;])/);
      if (m && m[1]) {
        const url = m[1];
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noreferrer";
        a.textContent = url;
        container.appendChild(a);
        i += url.length;
        continue;
      }
    }

    // fallback: emit the current character
    pushText(text[i]);
    i += 1;
  }
}

function renderMarkdown(mdText, baseReadmeRel = "") {
  const root = document.createElement("div");
  root.className = "md";

  const lines = (mdText || "").replaceAll("\r\n", "\n").split("\n");
  let i = 0;
  let inCode = false;
  let codeBuf = [];
  let codeLang = "";
  const listStack = []; // [{indent, el, type, lastLi}]

  const flushListsTo = (indent) => {
    while (listStack.length && listStack[listStack.length - 1].indent > indent) listStack.pop();
  };

  const flushAllLists = () => { listStack.length = 0; };

  const addBlock = (el) => {
    flushAllLists();
    root.appendChild(el);
  };

  const flushCode = () => {
    if (!codeBuf.length) return;
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    if (codeLang) code.setAttribute("data-lang", codeLang);
    code.textContent = codeBuf.join("\n");
    pre.appendChild(code);
    root.appendChild(pre);
    codeBuf = [];
    codeLang = "";
  };

  const openList = (type, indent) => {
    const el = document.createElement(type);
    if (listStack.length) {
      const parent = listStack[listStack.length - 1];
      if (parent.lastLi) parent.lastLi.appendChild(el);
      else root.appendChild(el);
    } else {
      root.appendChild(el);
    }
    listStack.push({indent, el, type, lastLi: null});
  };

  const currentList = () => (listStack.length ? listStack[listStack.length - 1] : null);

  const addListItem = (type, indent, content) => {
    // adjust stack
    if (!listStack.length) {
      openList(type, indent);
    } else {
      const top = currentList();
      if (indent > top.indent) {
        openList(type, indent);
      } else if (indent < top.indent) {
        flushListsTo(indent);
        const top2 = currentList();
        if (!top2 || top2.type !== type || top2.indent !== indent) openList(type, indent);
      } else if (top.type !== type) {
        // switch list type at same indent
        listStack.pop();
        openList(type, indent);
      }
    }
    const top = currentList();
    const li = document.createElement("li");

    const task = parseTaskPrefix(content.trim());
    if (task) {
      li.classList.add("task");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.disabled = true;
      cb.checked = task.checked;
      li.appendChild(cb);
      const span = document.createElement("span");
      renderInline(span, task.rest, baseReadmeRel);
      li.appendChild(span);
    } else {
      renderInline(li, content, baseReadmeRel);
    }

    top.el.appendChild(li);
    top.lastLi = li;
  };

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trimEnd();

    // fenced code
    const fence = t.match(/^\s*```([^`]*)\s*$/);
    if (fence) {
      if (inCode) {
        inCode = false;
        flushCode();
      } else {
        flushAllLists();
        inCode = true;
        codeLang = (fence[1] || "").trim();
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i++;
      continue;
    }

    // blank
    if (t.trim() === "") {
      flushAllLists();
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*(\*\s*){3,}\s*$/.test(t) || /^\s*(-\s*){3,}\s*$/.test(t) || /^\s*(_\s*){3,}\s*$/.test(t)) {
      const hr = document.createElement("hr");
      addBlock(hr);
      i++;
      continue;
    }

    // blockquote (multi-line)
    if (/^\s*>/.test(t)) {
      flushAllLists();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i].trimEnd())) {
        buf.push(lines[i].trimEnd().replace(/^\s*>\s?/, ""));
        i++;
      }
      const bq = document.createElement("blockquote");
      const inner = renderMarkdown(buf.join("\n"), baseReadmeRel);
      // move children
      while (inner.firstChild) bq.appendChild(inner.firstChild);
      root.appendChild(bq);
      continue;
    }

    // headings up to h6
    const hm = t.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      flushAllLists();
      const lvl = hm[1].length;
      const h = document.createElement("h" + lvl);
      renderInline(h, hm[2], baseReadmeRel);
      root.appendChild(h);
      i++;
      continue;
    }

    // tables: header + separator
    if (t.includes("|") && i + 1 < lines.length) {
      const t2 = lines[i + 1].trimEnd();
      if (t2.includes("|") && /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(t2)) {
        flushAllLists();
        const header = splitTableRow(t);
        const sep = splitTableRow(t2);
        const aligns = sep.map((c) => {
          const cc = c.replaceAll(" ", "");
          const left = cc.startsWith(":");
          const right = cc.endsWith(":");
          if (left && right) return "center";
          if (right) return "right";
          if (left) return "left";
          return "";
        });

        const table = document.createElement("table");
        const thead = document.createElement("thead");
        const trh = document.createElement("tr");
        header.forEach((cell, idx) => {
          const th = document.createElement("th");
          if (aligns[idx]) th.style.textAlign = aligns[idx];
          renderInline(th, cell, baseReadmeRel);
          trh.appendChild(th);
        });
        thead.appendChild(trh);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        i += 2;
        while (i < lines.length) {
          const row = lines[i].trimEnd();
          if (row.trim() === "" || !row.includes("|")) break;
          const cells = splitTableRow(row);
          const tr = document.createElement("tr");
          for (let cidx = 0; cidx < header.length; cidx++) {
            const td = document.createElement("td");
            if (aligns[cidx]) td.style.textAlign = aligns[cidx];
            renderInline(td, cells[cidx] || "", baseReadmeRel);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
          i++;
        }
        table.appendChild(tbody);
        root.appendChild(table);
        continue;
      }
    }

    // lists (nested by indent)
    const lm = line.match(/^(\s*)([-*+]|(\d+)\.)\s+(.*)$/);
    if (lm) {
      const indent = lm[1].replaceAll("\t", "  ").length;
      const ordered = Boolean(lm[3]);
      const type = ordered ? "ol" : "ul";
      addListItem(type, indent, lm[4] || "");
      i++;
      continue;
    }

    // paragraph (consume consecutive lines that are not blank and not starting a new block)
    flushAllLists();
    const para = [];
    while (i < lines.length) {
      const l = lines[i].trimEnd();
      if (l.trim() === "") break;
      if (/^\s*```/.test(l)) break;
      if (/^\s*>/.test(l)) break;
      if (/^(#{1,6})\s+/.test(l)) break;
      if (/^\s*(\*\s*){3,}\s*$/.test(l) || /^\s*(-\s*){3,}\s*$/.test(l) || /^\s*(_\s*){3,}\s*$/.test(l)) break;
      if (/^(\s*)([-*+]|(\d+)\.)\s+/.test(lines[i])) break;
      // table start
      if (l.includes("|") && i + 1 < lines.length && /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(lines[i + 1].trimEnd())) break;
      para.push(l);
      i++;
    }
    const p = document.createElement("p");
    renderInline(p, para.join(" "), baseReadmeRel);
    root.appendChild(p);
  }

  if (inCode) flushCode();
  return root;
}

async function loadReadme(info) {
  if (!info || !info.path) {
    clearReadme();
    return;
  }
  // size guard
  const max = 512 * 1024; // 512KiB
  readmeEl.classList.remove("hidden");
  readmeOpen.href = fileUrl(info.path);
  readmeBody.innerHTML = "";
  const loading = document.createElement("div");
  loading.className = "meta";
  loading.textContent = "Loading README…";
  readmeBody.appendChild(loading);

  try {
    const url = fileUrl(info.path);
    const res = await fetch(url, {headers: {"Range": `bytes=0-${Math.min(max - 1, info.size || (max - 1))}`}});
    if (!res.ok && res.status !== 206) throw new Error(await res.text());
    let txt = await res.text();
    if (info.size && info.size > max) txt += "\n\n…(truncated)…";
    readmeBody.innerHTML = "";
    readmeBody.appendChild(renderMarkdown(txt, info.path));
  } catch (e) {
    readmeBody.innerHTML = "";
    const err = document.createElement("div");
    err.className = "meta";
    err.textContent = `README failed to load: ${String(e)}`;
    readmeBody.appendChild(err);
  }
}

async function refresh() {
  const {rel, q} = parseView();
  renderCrumbs(rel);
  setStatus("Loading…");
  rows.innerHTML = "";
  try {
    if (searchEl && !searchEl.matches(":focus")) searchEl.value = q || "";

    if (q) {
      const data = await apiSearch(rel, q);
      lastList = data.items || [];
      applySort();
      selected = new Set();
      lastClickedIndex = -1;
      for (const it of lastList) rows.appendChild(rowFor(it));
      let msg = `${lastList.length} matches for “${q}”`;
      if (data && data.truncated) {
        const seen = (data.seen != null) ? `, scanned ${data.seen}` : "";
        msg += ` (truncated${seen})`;
      }
      setStatus(msg);
      updateSelectionUI();
      if (opUp) opUp.disabled = rel === "";
      clearReadme();
      await renderTree();
      return;
    }

    const data = await apiList(rel);
    lastList = data.items || [];
    applySort();
    selected = new Set(); // clear selection on navigation
    lastClickedIndex = -1;
    for (const it of data.items || []) rows.appendChild(rowFor(it));
    setStatus(`${(data.items||[]).length} items`);
    updateSelectionUI();
    if (opUp) opUp.disabled = rel === "";
    await loadReadme(data.readme);
    await renderTree();
  } catch (e) {
    setStatus(String(e));
    clearReadme();
    if (opUp) opUp.disabled = rel === "";
    await renderTree();
  }
}

async function doSearch() {
  const q = (searchEl.value || "").trim();
  const base = curPath();
  setView(base, q);
}

// --- upload queue ---
const UP_CHUNK = 8 * 1024 * 1024;
const UP_MAX = 3;
let upTasks = []; // [{tid,file,destRel,mode,status,sessionId,offset,err,createdAt}]
let upRunning = 0;
let upTid = 0;

function showUpqIfNeeded() {
  if (!upqEl) return;
  const any = upTasks.length > 0;
  upqEl.classList.toggle("hidden", !any);
}

function fmtPct(done, total) {
  if (!total) return "0%";
  return `${Math.floor((done / total) * 100)}%`;
}

function renderUpq() {
  if (!upqBody || !upqEl) return;
  showUpqIfNeeded();
  upqBody.innerHTML = "";
  for (const t of upTasks) {
    const row = document.createElement("div");
    row.className = "urow" + (t.status === "error" ? " err" : (t.status === "done" || t.status === "skipped" ? " ok" : ""));

    const info = document.createElement("div");
    info.className = "uinfo";
    const nm = document.createElement("div");
    nm.className = "uname";
    nm.textContent = t.destRel || (t.file?.name || "upload");
    const sub = document.createElement("div");
    sub.className = "usub";
    let subTxt = "";
    if (t.status === "queued") subTxt = "Queued";
    else if (t.status === "running") subTxt = `Uploading… ${fmtSize(t.offset)} / ${fmtSize(t.file.size)} (${fmtPct(t.offset, t.file.size)})`;
    else if (t.status === "paused") subTxt = `Paused at ${fmtPct(t.offset, t.file.size)}`;
    else if (t.status === "done") subTxt = "Done";
    else if (t.status === "skipped") subTxt = "Skipped (exists)";
    else if (t.status === "canceled") subTxt = "Canceled";
    else if (t.status === "error") subTxt = `Failed: ${t.err || "unknown error"}`;
    sub.textContent = subTxt;

    const bar = document.createElement("div");
    bar.className = "ubar";
    const barIn = document.createElement("div");
    const pct = t.file?.size ? Math.floor((t.offset / t.file.size) * 100) : 0;
    barIn.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    bar.appendChild(barIn);

    info.appendChild(nm);
    info.appendChild(sub);
    info.appendChild(bar);

    const acts = document.createElement("div");
    acts.className = "uacts";

    const mkBtn = (icon, title, on, disabled) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opbtn";
      b.title = title;
      b.innerHTML = iconUse(icon);
      if (disabled) b.disabled = true;
      b.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        on();
      };
      return b;
    };

    const canPause = t.status === "running";
    const canResume = t.status === "paused";
    const canRetry = t.status === "error";
    const canCancel = ["queued","running","paused","error"].includes(t.status);

    acts.appendChild(mkBtn(canResume ? "play" : "pause", canResume ? "Resume" : "Pause", () => {
      if (t.status === "running") pauseUpload(t.tid);
      else if (t.status === "paused") resumeUpload(t.tid);
    }, !(canPause || canResume)));

    acts.appendChild(mkBtn("retry", "Retry", () => retryUpload(t.tid), !canRetry));
    acts.appendChild(mkBtn("close", "Cancel", () => cancelUpload(t.tid), !canCancel));

    row.appendChild(info);
    row.appendChild(acts);
    upqBody.appendChild(row);
  }
}

async function enqueueUploads(files, useRelativePaths) {
  const dir = curPath();
  const list = [...(files || [])].filter((f) => f && f.name);
  for (const f of list) {
    const rp = useRelativePaths ? String(f.webkitRelativePath || f.name || "") : String(f.name || "");
    const destRel = dir ? `${dir}/${rp}` : rp;
    upTasks.push({
      tid: ++upTid,
      file: f,
      destRel,
      mode: "error",
      status: "queued",
      sessionId: null,
      offset: 0,
      err: "",
      createdAt: Date.now(),
    });
  }
  renderUpq();
  pumpUploads();
}

function findTask(tid) {
  return upTasks.find((t) => t.tid === tid);
}

function pauseUpload(tid) {
  const t = findTask(tid);
  if (!t || t.status !== "running") return;
  t.status = "paused";
  try { t.ctrl?.abort(); } catch {}
  renderUpq();
}

function resumeUpload(tid) {
  const t = findTask(tid);
  if (!t || t.status !== "paused") return;
  t.status = "queued";
  renderUpq();
  pumpUploads();
}

async function cancelUpload(tid) {
  const t = findTask(tid);
  if (!t) return;
  if (t.status === "running") {
    t.status = "canceled";
    try { t.ctrl?.abort(); } catch {}
  } else {
    t.status = "canceled";
  }
  renderUpq();
  if (t.sessionId) {
    try { await apiUploadCancel(t.sessionId); } catch {}
  }
}

async function retryUpload(tid) {
  const t = findTask(tid);
  if (!t || t.status !== "error") return;
  if (t.sessionId) {
    try { await apiUploadCancel(t.sessionId); } catch {}
  }
  t.sessionId = null;
  t.offset = 0;
  t.err = "";
  t.status = "queued";
  renderUpq();
  pumpUploads();
}

function pumpUploads() {
  if (upRunning >= UP_MAX) return;
  while (upRunning < UP_MAX) {
    const next = upTasks.find((t) => t.status === "queued");
    if (!next) break;
    upRunning++;
    next.status = "running";
    renderUpq();
    runUploadTask(next).finally(() => {
      upRunning = Math.max(0, upRunning - 1);
      renderUpq();
      pumpUploads();
    });
  }
}

async function requestUploadSession(t, file) {
  while (true) {
    const mode = t.mode || "error";
    try {
      return await apiUploadCreate2(t.destRel, file.size, mode, t.ctrl.signal);
    } catch (err) {
      if (err && err.status === 409) {
        const choice = await promptUploadConflict(t.destRel);
        if (!choice) {
          return null;
        }
        t.mode = choice;
        continue;
      }
      throw err;
    }
  }
}

async function runUploadTask(t) {
  const file = t.file;
  if (!file) return;
  t.ctrl = new AbortController();
  try {
    // Create or resume session.
    if (!t.sessionId) {
      const sess = await requestUploadSession(t, file);
      if (!sess) {
        t.status = "canceled";
        t.err = "upload canceled";
        toast("Upload canceled", {type: "info", sub: t.destRel});
        return;
      }
      if (sess && sess.skipped) {
        t.status = "skipped";
        return;
      }
      t.sessionId = sess.id;
      if (sess.dest) t.destRel = sess.dest;
      t.offset = sess.offset || 0;
    } else {
      // Sync offset in case previous request completed but the client aborted.
      const st = await apiUploadGet(t.sessionId, t.ctrl.signal);
      if (st && st.offset != null) t.offset = Number(st.offset) || 0;
    }

    while (t.offset < file.size) {
      if (t.status !== "running") return;
      const end = Math.min(file.size - 1, t.offset + UP_CHUNK - 1);
      const blob = file.slice(t.offset, end + 1);
      const r = await apiUploadPatch2(t.sessionId, t.offset, end, file.size, blob, t.ctrl.signal);
      t.offset = r.offset || (end + 1);
      renderUpq();
    }
    if (t.status !== "running") return;
    await apiUploadFinish2(t.sessionId, t.ctrl.signal);
    t.status = "done";
    toast("Uploaded", {type:"ok", sub: t.destRel});
    await refresh();
  } catch (e) {
    const msg = String(e);
    const isAbort = (e && (e.name === "AbortError" || msg.includes("AbortError"))) || msg.includes("aborted");
    if (isAbort && (t.status === "paused" || t.status === "canceled")) {
      return;
    }
    t.status = "error";
    t.err = msg;
    toast("Upload failed", {type:"err", sub: msg, dur: 4500});
  } finally {
    t.ctrl = null;
  }
}

// events
window.addEventListener("hashchange", () => refresh());
searchEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
});

// OneDrive-ish: sortable columns
document.querySelectorAll(".thead .sort").forEach((el) => {
  const k = el.getAttribute("data-sort") || "name";
  const act = () => {
    if (sortKey === k) sortDir *= -1;
    else { sortKey = k; sortDir = 1; }
    applySort();
    rerenderRows();
    updateSortHeader();
  };
  el.addEventListener("click", (ev) => { ev.preventDefault(); act(); });
  el.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); act(); }
  });
});
updateSortHeader();
fileEl.addEventListener("change", async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = "";
  if (files.length) await enqueueUploads(files, false);
});
fileDirEl?.addEventListener("change", async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = "";
  if (files.length) await enqueueUploads(files, true);
});

if (opUpload) opUpload.onclick = () => {
  fileEl?.click();
};
if (opUploadDir) opUploadDir.onclick = () => {
  fileDirEl?.click();
};
if (opWide) opWide.onclick = () => {
  setWideMode(!wideMode);
};
if (opUp) opUp.onclick = () => {
  const rel = curPath();
  if (!rel) return;
  const p = rel.split("/").filter(Boolean);
  p.pop();
  setPath(p.join("/"));
};
if (opMkdir) opMkdir.onclick = async () => {
  const rel = curPath();
  const name = prompt("Folder name:");
  if (!name) return;
  const dst = rel ? `${rel}/${name}` : name;
  try {
    await apiMkdir(dst);
    await refresh();
  } catch (e) {
    setStatus(String(e));
  }
};

if (opCopy) opCopy.onclick = () => setClip("copy", [...selected.values()]);
if (opCut) opCut.onclick = () => setClip("cut", [...selected.values()]);
if (opPaste) opPaste.onclick = () => pasteTo(curPath());

if (opZip) opZip.onclick = () => downloadSelectedZip();
if (opClear) opClear.onclick = () => {
  selected = new Set();
  updateSelectionUI();
  rows.innerHTML = "";
  for (const it of lastList) rows.appendChild(rowFor(it));
};

// drag-drop upload
document.addEventListener("dragover", (e) => { e.preventDefault(); });
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) await enqueueUploads(files, false);
});

if (upqClear) upqClear.onclick = () => {
  upTasks = upTasks.filter((t) => !["done","skipped","canceled"].includes(t.status));
  renderUpq();
};

// background context menu (empty space)
rows?.addEventListener("contextmenu", (ev) => {
  // If the event originated inside a row, row handler will take it.
  const row = ev.target?.closest?.(".row");
  if (row) return;
  ev.preventDefault();
  ev.stopPropagation();
  hideCtx();
  showCtxBg(ev.clientX, ev.clientY);
}, true);

// modal interactions
modalBackdrop.onclick = () => closeModal();
pvClose.onclick = () => closeModal();
if (pvPrev) pvPrev.onclick = () => openPreviewAt((pvCtx?.idx ?? 0) - 1);
if (pvNext) pvNext.onclick = () => openPreviewAt((pvCtx?.idx ?? 0) + 1);
if (pvSlide) pvSlide.onclick = () => {
  if (!pvCtx || !pvCtx.items || pvCtx.items.length === 0) return;
  const cur = pvCtx.items[pvCtx.idx];
  if (!cur || classify(cur) !== "image") return;
  if (pvSlideTimer) {
    try { window.clearInterval(pvSlideTimer); } catch {}
    pvSlideTimer = null;
    pvSlide.innerHTML = iconUse("play");
    return;
  }
  pvSlide.innerHTML = iconUse("pause");
  pvSlideTimer = window.setInterval(() => {
    if (!pvCtx) return;
    const n = pvCtx.idx + 1;
    if (n >= pvCtx.items.length) {
      // stop at end
      try { window.clearInterval(pvSlideTimer); } catch {}
      pvSlideTimer = null;
      if (pvSlide) pvSlide.innerHTML = iconUse("play");
      return;
    }
    openPreviewAt(n);
  }, 2500);
};
if (pvEdit) pvEdit.onclick = async () => {
  if (!pvEditState || !pvEditState.path) return;
  // Load full file (best-effort) up to 1MiB for editing.
  const max = 1024 * 1024;
  try {
    const res = await fetch(fileUrl(pvEditState.path), {headers: {"Range": `bytes=0-${max-1}`}});
    if (!res.ok && res.status !== 206) throw new Error(await res.text());
    let txt = await res.text();
    if (txt.length >= max) {
      toast("File too large to edit in browser", {type:"err", sub:`Limit ${fmtSize(max)}`, dur: 4500});
      return;
    }
    pvEditState.content = txt;
    pvEditState.dirty = false;

    pvBody.innerHTML = "";
    const ta = document.createElement("textarea");
    ta.className = "pv-pre";
    ta.style.width = "100%";
    ta.style.minHeight = "60vh";
    ta.value = txt;
    ta.oninput = () => {
      pvEditState.content = ta.value;
      pvEditState.dirty = true;
      if (pvSave) pvSave.disabled = false;
    };
    pvBody.appendChild(ta);
    ta.focus();
    if (pvSave) pvSave.disabled = true;
  } catch (e) {
    toast("Edit failed", {type:"err", sub:String(e), dur: 4500});
  }
};
if (pvSave) pvSave.onclick = async () => {
  if (!pvEditState || !pvEditState.path) return;
  const content = pvEditState.content ?? "";
  pvSave.disabled = true;
  pvSave.innerHTML = `${iconUse("check")} Saving…`;
  try {
    const r = await apiWrite(pvEditState.path, content, "overwrite");
    toast("Saved", {type:"ok", sub: r.path || pvEditState.path});
    pvEditState.dirty = false;
    pvSave.innerHTML = `${iconUse("check")} Save`;
    await refresh();
  } catch (e) {
    pvSave.disabled = false;
    pvSave.innerHTML = `${iconUse("check")} Save`;
    toast("Save failed", {type:"err", sub:String(e), dur: 4500});
  }
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
  if (e.key === "Escape" && ctxOpen) hideCtx();
  if (!modal.classList.contains("hidden")) {
    if (e.key === "ArrowLeft") { e.preventDefault(); openPreviewAt((pvCtx?.idx ?? 0) - 1); }
    if (e.key === "ArrowRight") { e.preventDefault(); openPreviewAt((pvCtx?.idx ?? 0) + 1); }
  }
});

// context menu interactions
ctx.oncontextmenu = (e) => { e.preventDefault(); };
document.addEventListener("mousedown", (e) => {
  if (ctxOpen && !ctx.contains(e.target)) hideCtx();
}, true);
document.addEventListener("scroll", () => { if (ctxOpen) hideCtx(); }, true);
window.addEventListener("resize", () => { if (ctxOpen) hideCtx(); });

function isTypingContext(ev) {
  const t = ev.target;
  if (!t) return false;
  const tag = (t.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (t.isContentEditable) return true;
  return false;
}

async function deleteSelectionFromKeyboard() {
  await deletePaths([...selected.values()]);
}

// Keyboard shortcuts: Ctrl/Cmd+A selects all files; Delete deletes selection.
document.addEventListener("keydown", async (e) => {
  if (isTypingContext(e)) return;
  // don't interfere with preview modal text selection / browsing
  if (!modal.classList.contains("hidden")) return;

  const key = (e.key || "").toLowerCase();
  const meta = e.metaKey || e.ctrlKey;

  if (meta && key === "a") {
    e.preventDefault();
    // Select all items (files + folders) in the current listing.
    const paths = (lastList || []).filter((it) => it && it.path).map((it) => it.path);
    setSelection(paths);
    rows.innerHTML = "";
    for (const it of lastList) rows.appendChild(rowFor(it));
    toast("Selected all items", {type: "ok", sub: `${paths.length} item(s)`});
    return;
  }

  if (meta && key === "c") {
    if (selected.size > 0) {
      e.preventDefault();
      setClip("copy", [...selected.values()]);
    }
    return;
  }
  if (meta && key === "x") {
    if (selected.size > 0) {
      e.preventDefault();
      setClip("cut", [...selected.values()]);
    }
    return;
  }
  if (meta && key === "v") {
    if (clip && Array.isArray(clip.paths) && clip.paths.length > 0) {
      e.preventDefault();
      await pasteTo(curPath());
    }
    return;
  }

  if ((e.key === "Delete" || e.key === "Backspace") && selected.size > 0) {
    e.preventDefault();
    await deleteSelectionFromKeyboard();
  }
}, true);

initWideMode();
clip = loadClip();
updateSelectionUI();
refresh();


