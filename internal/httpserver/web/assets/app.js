const $ = (id) => document.getElementById(id);

const rows = $("rows");
const crumbs = $("crumbs");
const statusEl = $("status");
const searchEl = $("search");
const fileEl = $("file");
const opUp = $("op-up");
const opUpload = $("op-upload");
const opMkdir = $("op-mkdir");
const opZip = $("op-zip");
const opClear = $("op-clear");
const opWide = $("op-wide");

const modal = $("modal");
const modalBackdrop = $("modal-backdrop");
const pvClose = $("pv-close");
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

let lastList = [];
let selected = new Set();
let lastClickedIndex = -1;
let ren = null; // {path, value}
let renFocus = null; // path to focus after rerender

let wideMode = false;

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

function fileUrl(rel, opts = {}) {
  const base = `/f/${encPath(rel)}`;
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
  return ["image","video","audio","pdf","text"].includes(kind);
}

function iconUse(id) {
  return `<svg class="i" aria-hidden="true"><use href="/assets/icons.svg#${id}"></use></svg>`;
}

function rerenderRows() {
  if (!rows) return;
  rows.innerHTML = "";
  for (const it of (lastList || [])) rows.appendChild(rowFor(it));
}

function thumbUrl(u, size) {
  if (!u) return u;
  const s = Number(size) || 0;
  if (s <= 0) return u;
  return u + (u.includes("?") ? "&" : "?") + `s=${encodeURIComponent(String(s))}`;
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

  addItem("link", "Copy link", async () => {
    const link = `${location.origin}${fileUrl(item.path)}`;
    const ok = await copyText(link);
    if (ok) toast("Copied link", {type: "ok", sub: link});
    else toast("Copy failed", {type: "err", sub: link, dur: 4500});
  });

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

function updateSelectionUI() {
  updateStatusText();
  // enable/disable ops
  const hasSel = selected.size > 0;
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
  form.action = "/api/zip";
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
  const res = await fetch(`/api/list?path=${encodeURIComponent(rel || "")}`);
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
  const res = await fetch(`/api/search?path=${encodeURIComponent(baseRel || "")}&q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiMkdir(rel) {
  const res = await fetch(`/api/mkdir`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({path: rel})
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiRename(fromRel, toRel) {
  const res = await fetch(`/api/rename`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({from: fromRel, to: toRel})
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiDelete(rel) {
  const res = await fetch(`/api/delete`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({path: rel})
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiUploadCreate(destRel, size) {
  const res = await fetch(`/api/uploads?path=${encodeURIComponent(destRel)}&size=${encodeURIComponent(size)}`, {method:"POST"});
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiUploadPatch(id, start, end, total, blob) {
  const res = await fetch(`/api/uploads/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {"Content-Range": `bytes ${start}-${end}/${total}`},
    body: blob
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiUploadFinish(id) {
  const res = await fetch(`/api/uploads/${encodeURIComponent(id)}/finish`, {method:"POST"});
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
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
}

async function openPreview(item) {
  const kind = classify(item);
  const url = fileUrl(item.path);
  pvTitle.textContent = item.path || item.name || "";
  pvOpen.href = url;
  pvDownload.href = fileUrl(item.path, {dl:true});
  pvDownload.setAttribute("download", item.name || "download");

  pvBody.innerHTML = "";
  openModal();

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
    try {
      // Avoid loading huge files: fetch only the first 256KiB via Range.
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
  if (item.thumb && kind === "image") {
    ico.classList.add("thumb");
    ico.style.backgroundImage = `url("${item.thumb}")`;
  } else {
    ico.innerHTML = iconUse(kind);
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

async function uploadFile(file, dirRel, idx, total) {
  const destRel = dirRel ? `${dirRel}/${file.name}` : file.name;
  const chunkSize = 8 * 1024 * 1024;

  const prefix = (idx && total) ? `(${idx}/${total}) ` : "";
  const t = toast(`${prefix}Uploading ${file.name}`, {
    type: "info",
    dur: 0, // persistent while uploading
    progress: 0,
    sub: `${fmtSize(0)} / ${fmtSize(file.size)} (0%)`,
  });

  try {
    setStatus(`Uploading ${file.name} (${fmtSize(file.size)})…`);
    const sess = await apiUploadCreate(destRel, file.size);
    let offset = sess.offset || 0;

    while (offset < file.size) {
      const end = Math.min(file.size - 1, offset + chunkSize - 1);
      const blob = file.slice(offset, end + 1);
      const r = await apiUploadPatch(sess.id, offset, end, file.size, blob);
      offset = r.offset || (end + 1);
      const pct = Math.floor((offset / file.size) * 100);
      setStatus(`Uploading ${file.name}… ${pct}%`);
      t?.setProgress(pct);
      t?.setSub(`${fmtSize(offset)} / ${fmtSize(file.size)} (${pct}%)`);
    }

    await apiUploadFinish(sess.id);
    t?.close();
    toast(`Uploaded ${file.name}`, {type: "ok", sub: fmtSize(file.size)});
    setStatus(`Uploaded ${file.name}`);
  } catch (e) {
    t?.close();
    toast(`Upload failed: ${file.name}`, {type: "err", sub: String(e)});
    throw e;
  }
}

async function uploadFiles(files) {
  const dir = curPath();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    try {
      await uploadFile(f, dir, i + 1, files.length);
    } catch (e) {
      setStatus(`Upload failed: ${String(e)}`);
      throw e;
    }
  }
  await refresh();
}

// events
window.addEventListener("hashchange", () => refresh());
searchEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
});
fileEl.addEventListener("change", async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = "";
  if (files.length) await uploadFiles(files);
});

if (opUpload) opUpload.onclick = () => {
  fileEl?.click();
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
  if (files.length) await uploadFiles(files);
});

// modal interactions
modalBackdrop.onclick = () => closeModal();
pvClose.onclick = () => closeModal();
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
  if (e.key === "Escape" && ctxOpen) hideCtx();
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

  if ((e.key === "Delete" || e.key === "Backspace") && selected.size > 0) {
    e.preventDefault();
    await deleteSelectionFromKeyboard();
  }
}, true);

initWideMode();
refresh();


