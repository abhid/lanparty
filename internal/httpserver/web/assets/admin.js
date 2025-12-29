'use strict';

const BASE = (() => {
  try {
    const path = String(location.pathname || '/');
    const match = path.match(/^\/s\/([^/]+)(?:\/|$)/);
    if (match && match[1]) {
      return `/s/${match[1]}`;
    }
  } catch (_) {
    // ignore
  }
  return '';
})();

const $ = (id) => document.getElementById(id);
const toasts = $('toasts');

const els = {
  save: $('cfg-save'),
  discard: $('cfg-discard'),
  status: $('cfg-status'),
  persist: $('cfg-persist'),
  summary: $('admin-summary'),
  general: $('cfg-general'),
  acls: $('cfg-acls'),
  shares: $('cfg-shares'),
  shareAdd: $('cfg-share-add'),
  usersList: $('users-list'),
  usersEmpty: $('users-empty'),
  userName: $('user-name'),
  userPass: $('user-pass'),
  userCost: $('user-cost'),
  userSave: $('user-save'),
  tokensList: $('tokens-list'),
  tokensEmpty: $('tokens-empty'),
  tokenUser: $('tok-user'),
  tokenCreate: $('tok-create'),
  tokenOutput: $('tok-output'),
  tokenCopy: $('tok-copy'),
  tokenRevoke: $('tok-revoke'),
  tokenRevokeBtn: $('tok-revoke-btn'),
  bcryptPass: $('bcrypt-pass'),
  bcryptCost: $('bcrypt-cost'),
  bcryptGenerate: $('bcrypt-generate'),
  bcryptOutput: $('bcrypt-output'),
  bcryptCopy: $('bcrypt-copy'),
};
const panes = document.querySelectorAll('.admin-pane');
const navItems = document.querySelectorAll('.nav-item');

const state = {
  config: null,
  shareList: [],
  dirty: false,
  saving: false,
  persisted: false,
  configPath: '',
  users: [],
  tokens: [],
};

init();

function init() {
  bindEvents();
  initNav();
  loadConfig();
  refreshState();
}

function bindEvents() {
  els.save?.addEventListener('click', () => saveConfig());
  els.discard?.addEventListener('click', () => discardChanges());
  els.shareAdd?.addEventListener('click', () => addShare());
  els.userSave?.addEventListener('click', () => createUser());
  els.tokenCreate?.addEventListener('click', () => createToken());
  els.tokenCopy?.addEventListener('click', () => copyToken());
  els.tokenRevokeBtn?.addEventListener('click', () => revokeToken());
  els.bcryptGenerate?.addEventListener('click', () => generateBcrypt());
  els.bcryptCopy?.addEventListener('click', () => copyBcrypt());
}

function initNav() {
  const first = navItems[0]?.dataset.pane || 'general';
  navItems.forEach((btn) => {
    btn.addEventListener('click', () => activatePane(btn.dataset.pane));
  });
  activatePane(first);
}

function activatePane(name) {
  navItems.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.pane === name);
  });
  panes.forEach((pane) => {
    pane.classList.toggle('active', pane.dataset.pane === name);
  });
}

async function loadConfig(showToast = false) {
  try {
    const res = await fetch(`${BASE}/api/admin/config`);
    if (!res.ok) {
      throw new Error(await res.text());
    }
    const data = await res.json();
    applyConfigResponse(data);
    if (showToast) {
      toast('Configuration reloaded', 'info');
    }
  } catch (err) {
    toast('Failed to load config', 'err', String(err));
  }
}

function applyConfigResponse(data) {
  const cfg = data?.config || {};
  state.config = {
    root: cfg.root || '',
    stateDir: cfg.stateDir || '',
    followSymlinks: !!cfg.followSymlinks,
    authOptional: !!cfg.authOptional,
    acls: normalizeAclList(cfg.acls),
  };
  state.shareList = sharesMapToList(cfg.shares || {});
  state.persisted = !!data?.persisted;
  state.configPath = data?.configPath || '';
  state.dirty = false;
  els.shareAdd && (els.shareAdd.disabled = false);
  renderGeneral();
  renderGlobalACLs();
  renderShares();
  updatePersistMessage();
  updateStatus();
}

async function refreshState() {
  try {
    const res = await fetch(`${BASE}/api/admin/state`);
    if (!res.ok) {
      throw new Error(await res.text());
    }
    const data = await res.json();
    state.users = Array.isArray(data.users) ? data.users : [];
    state.tokens = Array.isArray(data.tokens) ? data.tokens : [];
    if (typeof data.persisted === 'boolean') {
      state.persisted = data.persisted;
    }
    if (data.configPath) {
      state.configPath = data.configPath;
    }
    renderUsers();
    renderTokens();
    updateSummary();
    updatePersistMessage();
  } catch (err) {
    if (els.summary) {
      els.summary.textContent = `admin state failed: ${String(err)}`;
    }
  }
}

function renderGeneral() {
  if (!els.general) return;
  els.general.innerHTML = '';
  if (!state.config) {
    els.general.innerHTML = '<div class="meta">Configuration is loading…</div>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'admin-table form-table';
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);

  const addRow = (label, control, hint) => {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.textContent = label;
    const td = document.createElement('td');
    td.appendChild(control);
    if (hint) {
      const tip = document.createElement('div');
      tip.className = 'tip';
      tip.textContent = hint;
      td.appendChild(tip);
    }
    tr.appendChild(th);
    tr.appendChild(td);
    tbody.appendChild(tr);
  };

  addRow('Root path', createTextInput(state.config.root, '/srv/lanparty', (val) => {
    state.config.root = val;
    markDirty();
  }), 'Filesystem path served at "/"');

  addRow('State directory', createTextInput(state.config.stateDir, '<root>/.lanparty', (val) => {
    state.config.stateDir = val;
    markDirty();
  }), 'Runtime data for uploads/dedup/thumbs');

  const authSelect = document.createElement('select');
  authSelect.className = 'renin';
  [
    { value: 'false', label: 'Require auth for read' },
    { value: 'true', label: 'Allow anonymous read' },
  ].forEach((opt) => {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    authSelect.appendChild(option);
  });
  authSelect.value = state.config.authOptional ? 'true' : 'false';
  authSelect.addEventListener('change', (e) => {
    state.config.authOptional = e.target.value === 'true';
    markDirty();
  });
  addRow('Auth optional', authSelect, 'Public read access; writes still require auth');

  const followSelect = document.createElement('select');
  followSelect.className = 'renin';
  [
    { value: 'false', label: 'Do not follow symlinks' },
    { value: 'true', label: 'Follow symlinks within root' },
  ].forEach((opt) => {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    followSelect.appendChild(option);
  });
  followSelect.value = state.config.followSymlinks ? 'true' : 'false';
  followSelect.addEventListener('change', (e) => {
    state.config.followSymlinks = e.target.value === 'true';
    markDirty();
  });
  addRow('Follow symlinks', followSelect, 'Applies to the default share at "/"');

  els.general.appendChild(table);
}

function renderGlobalACLs() {
  if (!els.acls) return;
  const list = state.config?.acls || [];
  renderAclList(els.acls, list, {
    emptyText: 'No ACL rules. Authenticated users inherit the default policy.',
    addLabel: 'Add ACL rule',
  });
}

function renderShares() {
  if (!els.shares) return;
  els.shares.innerHTML = '';
  if (!state.config) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = 'Configuration is loading…';
    els.shares.appendChild(meta);
    els.shareAdd && (els.shareAdd.disabled = true);
    return;
  }
  els.shareAdd && (els.shareAdd.disabled = false);
  if (!state.shareList.length) {
    const empty = document.createElement('div');
    empty.className = 'meta';
    empty.textContent = 'No shares yet. Serve additional roots via /s/<name>.';
    els.shares.appendChild(empty);
    return;
  }

  const table = document.createElement('table');
  table.className = 'admin-table share-table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Name</th><th>Root</th><th>State dir</th><th>Symlinks</th><th>Rules</th><th style=\"text-align:right\">Actions</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);

  state.shareList.forEach((share) => {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    nameTd.appendChild(createTextInput(share.name, 'photos', (val) => {
      share.name = val;
      markDirty();
    }));
    tr.appendChild(nameTd);

    const rootTd = document.createElement('td');
    rootTd.appendChild(createTextInput(share.root, '/srv/photos', (val) => {
      share.root = val;
      markDirty();
    }));
    tr.appendChild(rootTd);

    const stateTd = document.createElement('td');
    stateTd.appendChild(createTextInput(share.stateDir, '<root>/.lanparty', (val) => {
      share.stateDir = val;
      markDirty();
    }));
    tr.appendChild(stateTd);

    const followTd = document.createElement('td');
    const followSelect = document.createElement('select');
    followSelect.className = 'renin';
    [
      { value: 'inherit', label: 'Inherit' },
      { value: 'true', label: 'Follow' },
      { value: 'false', label: 'Do not follow' },
    ].forEach((opt) => {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      followSelect.appendChild(option);
    });
    followSelect.value = share.followMode || 'inherit';
    followSelect.addEventListener('change', (e) => {
      share.followMode = e.target.value;
      markDirty();
    });
    followTd.appendChild(followSelect);
    tr.appendChild(followTd);

  const rulesTd = document.createElement('td');
  const rulesBtn = document.createElement('button');
  rulesBtn.type = 'button';
  rulesBtn.className = 'btn ghost';
  rulesBtn.innerHTML = `${iconUse('link')}ACLs`;
  rulesTd.appendChild(rulesBtn);
  tr.appendChild(rulesTd);

  const actionTd = document.createElement('td');
  actionTd.style.textAlign = 'right';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn ghost danger';
    removeBtn.innerHTML = `${iconUse('trash')}Delete`;
    removeBtn.addEventListener('click', () => {
      if (!confirm(`Remove share \"${share.name || ''}\"?`)) return;
      state.shareList = state.shareList.filter((s) => s.id !== share.id);
      renderShares();
      markDirty();
    });
    actionTd.appendChild(removeBtn);
    tr.appendChild(actionTd);

  const detailRow = document.createElement('tr');
  detailRow.className = 'share-detail-row hidden';
    const detailCell = document.createElement('td');
  detailCell.colSpan = 6;
    detailRow.appendChild(detailCell);

    rulesBtn.addEventListener('click', () => {
      const hidden = detailRow.classList.toggle('hidden');
      rulesBtn.innerHTML = hidden ? `${iconUse('link')}Show` : `${iconUse('chevd')}Hide`;
      if (!hidden) {
        detailCell.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'table-wrap';
        renderAclList(wrap, share.acls || (share.acls = []), {
          emptyText: 'No share-specific ACLs. Global ACLs will be used.',
          addLabel: 'Add share rule',
        });
        detailCell.appendChild(wrap);
      }
    });

    tbody.appendChild(tr);
    tbody.appendChild(detailRow);
  });

  els.shares.appendChild(table);
}





function renderAclList(container, list, opts = {}) {
  container.innerHTML = '';
  if (!list.length) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = opts.emptyText || 'No ACL rules yet.';
    container.appendChild(meta);
  }
  if (list.length) {
    const table = document.createElement('table');
    table.className = 'admin-table acl-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Path</th><th>Read</th><th>Write</th><th>Admin</th><th style=\"text-align:right\">Actions</th></tr>';
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    list.forEach((acl, idx) => {
      const tr = document.createElement('tr');

      const pathTd = document.createElement('td');
      pathTd.appendChild(createTextInput(acl.path, '/photos or /', (val) => {
        acl.path = val;
        markDirty();
      }));
      tr.appendChild(pathTd);

      const readTd = document.createElement('td');
      readTd.appendChild(createListInput('', acl.read || [], (vals) => {
        acl.read = vals;
        markDirty();
      }, true));
      tr.appendChild(readTd);

      const writeTd = document.createElement('td');
      writeTd.appendChild(createListInput('', acl.write || [], (vals) => {
        acl.write = vals;
        markDirty();
      }, true));
      tr.appendChild(writeTd);

      const adminTd = document.createElement('td');
      adminTd.appendChild(createListInput('', acl.admin || [], (vals) => {
        acl.admin = vals;
        markDirty();
      }, true));
      tr.appendChild(adminTd);

      const actionTd = document.createElement('td');
      actionTd.style.textAlign = 'right';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn ghost danger';
      remove.innerHTML = `${iconUse('trash')}Delete`;
      remove.addEventListener('click', () => {
        list.splice(idx, 1);
        renderAclList(container, list, opts);
        markDirty();
      });
      actionTd.appendChild(remove);
      tr.appendChild(actionTd);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);
  }

  const addWrap = document.createElement('div');
  addWrap.className = 'cfg-actions-row';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn ghost';
  addBtn.innerHTML = `${iconUse('newfolder')}${opts.addLabel || 'Add rule'}`;
  addBtn.addEventListener('click', () => {
    list.push({ path: '/', read: ['*'], write: [], admin: [] });
    renderAclList(container, list, opts);
    markDirty();
  });
  addWrap.appendChild(addBtn);
  container.appendChild(addWrap);
}

function createListInput(labelText, values, onChange, compact = false) {
  const wrap = document.createElement('div');
  wrap.className = 'cfg-list-field';
  if (!compact && labelText) {
    const label = document.createElement('div');
    label.className = 'meta';
    label.textContent = `${labelText} (comma separated)`;
    wrap.appendChild(label);
  }
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'renin';
  input.placeholder = labelText === 'Read' || compact ? '* or usernames' : 'user1, user2';
  input.value = (values && values.length) ? values.join(', ') : '';
  input.addEventListener('input', (e) => onChange && onChange(parseList(e.target.value)));
  wrap.appendChild(input);
  return wrap;
}

function createTextInput(value, placeholder, onInput) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'renin';
  input.value = value || '';
  if (placeholder) input.placeholder = placeholder;
  input.addEventListener('input', (e) => onInput && onInput(e.target.value));
  return input;
}

function parseList(str) {
  return String(str || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function addShare() {
  if (!state.config) return;
  const share = {
    id: makeId(),
    name: '',
    root: '',
    stateDir: '',
    followMode: 'inherit',
    acls: [],
  };
  state.shareList.push(share);
  renderShares();
  markDirty();
}

function sharesMapToList(map) {
  const names = Object.keys(map || {}).sort((a, b) => a.localeCompare(b));
  return names.map((name) => {
    const sh = map[name] || {};
    return {
      id: makeId(),
      name,
      root: sh.root || '',
      stateDir: sh.stateDir || '',
      followMode: typeof sh.followSymlinks === 'boolean' ? (sh.followSymlinks ? 'true' : 'false') : 'inherit',
      acls: normalizeAclList(sh.acls),
    };
  });
}

function normalizeAclList(list) {
  if (!Array.isArray(list)) return [];
  return list.map((acl) => ({
    path: acl.path || '/',
    read: Array.isArray(acl.read) ? [...acl.read] : [],
    write: Array.isArray(acl.write) ? [...acl.write] : [],
    admin: Array.isArray(acl.admin) ? [...acl.admin] : [],
  }));
}

function markDirty() {
  if (!state.config) return;
  state.dirty = true;
  updateStatus();
}

function updateStatus() {
  if (!els.status) return;
  if (!state.config) {
    els.status.textContent = 'Loading configuration…';
    if (els.save) els.save.disabled = true;
    if (els.discard) els.discard.disabled = true;
    return;
  }
  const savingText = state.saving ? 'Saving…' : 'Save changes';
  if (els.save) {
    els.save.disabled = !state.dirty || state.saving;
    els.save.innerHTML = `${iconUse('save')}${savingText}`;
  }
  if (els.discard) {
    els.discard.disabled = !state.dirty || state.saving;
  }
  els.status.textContent = state.dirty ? 'Unsaved changes' : 'All changes saved';
}

function updatePersistMessage() {
  if (!els.persist) return;
  if (state.persisted) {
    els.persist.textContent = state.configPath ? `Config file: ${state.configPath}` : 'Config file detected.';
  } else {
    els.persist.textContent = 'No config file loaded. Changes stay in-memory until restart.';
  }
}

function updateSummary() {
  if (!els.summary) return;
  els.summary.textContent = `Users: ${state.users.length} · Tokens: ${state.tokens.length}`;
}

function sharesListToMap() {
  const map = {};
  const seen = new Set();
  for (const share of state.shareList) {
    const name = (share.name || '').trim();
    if (!name) {
      throw new Error('Each share needs a name.');
    }
    if (/[\/\\#?]/.test(name)) {
      throw new Error(`Share ${name}: name cannot include /, \\, #, or ?`);
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate share name "${name}".`);
    }
    const root = (share.root || '').trim();
    if (!root) {
      throw new Error(`Share ${name}: root path is required.`);
    }
    const entry = {
      root,
      stateDir: (share.stateDir || '').trim(),
      acls: normalizeAclPayload(share.acls),
    };
    if (share.followMode === 'true') entry.followSymlinks = true;
    else if (share.followMode === 'false') entry.followSymlinks = false;
    map[name] = entry;
    seen.add(name);
  }
  return map;
}

function normalizeAclPayload(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return [];
  }
  return list.map((acl) => ({
    path: formatPath(acl.path),
    read: parseList(Array.isArray(acl.read) ? acl.read.join(',') : acl.read),
    write: parseList(Array.isArray(acl.write) ? acl.write.join(',') : acl.write),
    admin: parseList(Array.isArray(acl.admin) ? acl.admin.join(',') : acl.admin),
  }));
}

function formatPath(path) {
  const trimmed = String(path || '').trim();
  if (!trimmed || trimmed === '/') return '/';
  return `/${trimmed.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

async function saveConfig() {
  if (!state.config || state.saving || !state.dirty) {
    return;
  }
  let payload;
  try {
    payload = {
      root: state.config.root || '',
      stateDir: state.config.stateDir || '',
      followSymlinks: !!state.config.followSymlinks,
      authOptional: !!state.config.authOptional,
      acls: normalizeAclPayload(state.config.acls),
      shares: sharesListToMap(),
    };
    if (!payload.root && Object.keys(payload.shares).length === 0) {
      throw new Error('Set a root or define at least one share.');
    }
  } catch (err) {
    toast('Cannot save config', 'err', String(err));
    return;
  }
  setSaving(true);
  try {
    const res = await fetch(`${BASE}/api/admin/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(await res.text());
    }
    const data = await res.json();
    applyConfigResponse(data);
    toast('Configuration saved', 'ok');
  } catch (err) {
    toast('Save failed', 'err', String(err));
  } finally {
    setSaving(false);
  }
}

async function discardChanges() {
  if (!state.dirty) return;
  await loadConfig();
  toast('Changes discarded', 'info');
}

function setSaving(flag) {
  state.saving = flag;
  updateStatus();
}

async function createUser() {
  const username = (els.userName?.value || '').trim();
  const password = els.userPass?.value || '';
  const cost = Number(els.userCost?.value || '10');
  if (!username) {
    toast('Missing username', 'err');
    return;
  }
  if (!password) {
    toast('Missing password', 'err');
    return;
  }
  try {
    const res = await fetch(`${BASE}/api/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, cost }),
    });
    if (!res.ok) {
      throw new Error(await res.text());
    }
    els.userPass.value = '';
    toast('User saved', 'ok', username);
    refreshState();
  } catch (err) {
    toast('User save failed', 'err', String(err));
  }
}

function renderUsers() {
  if (!els.usersList || !els.usersEmpty) return;
  els.usersList.innerHTML = '';
  if (!state.users.length) {
    els.usersEmpty.classList.remove('hidden');
    return;
  }
  els.usersEmpty.classList.add('hidden');
  const table = document.createElement('table');
  table.className = 'admin-table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>User</th><th style="text-align:right">Actions</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  state.users.forEach((user) => {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    nameTd.textContent = user;
    const actionTd = document.createElement('td');
    actionTd.style.textAlign = 'right';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn ghost danger';
    remove.innerHTML = `${iconUse('trash')}Delete`;
    remove.addEventListener('click', () => deleteUser(user));
    actionTd.appendChild(remove);
    tr.appendChild(nameTd);
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  els.usersList.appendChild(table);
}

async function deleteUser(username) {
  if (!username) return;
  if (!confirm(`Delete user "${username}"? This also revokes their tokens.`)) {
    return;
  }
  try {
    const res = await fetch(`${BASE}/api/admin/users`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    if (!res.ok) {
      throw new Error(await res.text());
    }
    toast('User deleted', 'ok', username);
    refreshState();
  } catch (err) {
    toast('Delete failed', 'err', String(err));
  }
}

async function createToken() {
  const username = (els.tokenUser?.value || '').trim();
  if (!username) {
    toast('Missing username', 'err');
    return;
  }
  try {
    const res = await fetch(`${BASE}/api/admin/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    if (!res.ok) {
      throw new Error(await res.text());
    }
    const data = await res.json();
    if (els.tokenOutput) {
      els.tokenOutput.value = data.token || '';
    }
    if (els.tokenCopy) {
      els.tokenCopy.disabled = !(data.token);
    }
    toast('Token created', 'ok', username);
    refreshState();
  } catch (err) {
    toast('Token create failed', 'err', String(err));
  }
}

async function revokeToken() {
  const token = (els.tokenRevoke?.value || '').trim();
  if (!token) {
    toast('Missing token', 'err');
    return;
  }
  try {
    const res = await fetch(`${BASE}/api/admin/tokens`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      throw new Error(await res.text());
    }
    if (els.tokenRevoke) {
      els.tokenRevoke.value = '';
    }
    toast('Token revoked', 'ok');
    refreshState();
  } catch (err) {
    toast('Revoke failed', 'err', String(err));
  }
}

function renderTokens() {
  if (!els.tokensList || !els.tokensEmpty) return;
  els.tokensList.innerHTML = '';
  if (!state.tokens.length) {
    els.tokensEmpty.classList.remove('hidden');
    return;
  }
  els.tokensEmpty.classList.add('hidden');
  const table = document.createElement('table');
  table.className = 'admin-table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Token</th><th>User</th><th style="text-align:right">Actions</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  state.tokens.forEach((tok) => {
    const tr = document.createElement('tr');
    const tokenTd = document.createElement('td');
    tokenTd.textContent = `${tok.tokenPrefix || '????'}…`;
    const userTd = document.createElement('td');
    userTd.textContent = tok.user || 'unknown';
    const actionTd = document.createElement('td');
    actionTd.style.textAlign = 'right';
    const revokeBtn = document.createElement('button');
    revokeBtn.type = 'button';
    revokeBtn.className = 'btn ghost';
    revokeBtn.innerHTML = `${iconUse('edit')}Prepare revoke`;
    revokeBtn.addEventListener('click', () => prepareTokenRevoke(tok.tokenPrefix));
    actionTd.appendChild(revokeBtn);
    tr.appendChild(tokenTd);
    tr.appendChild(userTd);
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  els.tokensList.appendChild(table);
}

function prepareTokenRevoke(prefix) {
  if (!els.tokenRevoke) return;
  els.tokenRevoke.value = '';
  els.tokenRevoke.placeholder = prefix ? `Paste full token starting with ${prefix}…` : 'Paste full token…';
  els.tokenRevoke.focus();
  toast('Paste full token to revoke', 'info', prefix ? `${prefix}…` : '');
}

function copyToken() {
  if (!els.tokenOutput?.value) return;
  copyText(els.tokenOutput.value);
  toast('Token copied', 'ok');
}

async function generateBcrypt() {
  const password = els.bcryptPass?.value || '';
  const cost = Number(els.bcryptCost?.value || '10');
  if (!password) {
    toast('Missing password', 'err');
    return;
  }
  try {
    const res = await fetch(`${BASE}/api/admin/bcrypt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, cost }),
    });
    if (!res.ok) {
      throw new Error(await res.text());
    }
    const data = await res.json();
    if (els.bcryptOutput) {
      els.bcryptOutput.value = data.bcrypt || '';
    }
    if (els.bcryptCopy) {
      els.bcryptCopy.disabled = !data.bcrypt;
    }
    toast('Hash generated', 'ok');
  } catch (err) {
    toast('bcrypt failed', 'err', String(err));
  }
}

function copyBcrypt() {
  if (!els.bcryptOutput?.value) return;
  copyText(els.bcryptOutput.value);
  toast('Hash copied', 'ok');
}

function copyText(text) {
  try {
    navigator.clipboard?.writeText(text);
    return true;
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    return true;
  }
}

function toast(msg, type = 'ok', sub = '', dur = 2800) {
  if (!toasts) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `
    <div class="trow">
      <div class="ti">${iconUse(type === 'err' ? 'close' : 'check')}</div>
      <div class="msg">${msg}${sub ? `<div class="sub">${sub}</div>` : ''}</div>
      <button class="x" type="button">${iconUse('close')}</button>
    </div>`;
  el.querySelector('.x').onclick = () => el.remove();
  el.onclick = () => el.remove();
  toasts.appendChild(el);
  if (dur > 0) {
    setTimeout(() => el.isConnected && el.remove(), dur);
  }
}

function iconUse(id) {
  return `<svg class="i" aria-hidden="true"><use href="/assets/icons.svg#${id}"></use></svg>`;
}

function makeId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `share-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

