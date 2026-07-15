// ==UserScript==
// @name         Dandelion Session Saver
// @namespace    https://github.com/AyuBloom/Dandelion
// @version      0.1.1
// @description  Manage and attach Dandelion sessions from the ZOMBS.io client.
// @match        https://zombs.io/*
// @match        https://www.zombs.io/*
// @match        http://localhost/*
// @match        https://localhost/*
// @match        http://127.0.0.1/*
// @match        https://127.0.0.1/*
// @match        file:///*
// @connect      *
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  const STORAGE_KEY = "dandelion.session-saver.v1";
  const DEFAULT_HOST = {
    id: "local",
    name: "Local",
    url: "http://127.0.0.1:50000",
  };
  const pageWindow = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const nativeWebSocket = pageWindow.WebSocket;

  const settings = loadSettings();
  const state = {
    game: null,
    network: null,
    sessions: [],
    activeAttachment: null,
    hostDraftId: settings.selectedHostId,
    refreshTimer: null,
    clientTimer: null,
    passwordResolver: null,
    status: { tone: "idle", text: "Waiting for client" },
  };

  const host = document.createElement("div");
  host.id = "dandelion-userscript";
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
    <style>
      :host, *, *::before, *::after { box-sizing: border-box; }
      button, input, select { font: inherit; letter-spacing: 0; }
      button { cursor: pointer; }
      button:disabled { cursor: default; opacity: .45; }
      .launcher, .panel, dialog { pointer-events: auto; font-family: "Trebuchet MS", Arial, sans-serif; color: #f6f7f8; }
      .launcher {
        position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
        width: 40px; height: 34px; border: 1px solid #59616e; border-radius: 6px;
        background: #1a1e24; color: #f6f7f8; font-size: 16px; font-weight: 800;
        box-shadow: 0 3px 12px rgba(0,0,0,.36); display: grid; place-items: center;
      }
      .launcher[hidden], .panel[hidden], .view[hidden] { display: none; }
      .dot { position: absolute; width: 7px; height: 7px; right: 5px; top: 5px; border-radius: 50%; background: #7d8794; }
      .dot[data-tone="good"] { background: #69c77b; }
      .dot[data-tone="busy"] { background: #e9b949; }
      .dot[data-tone="bad"] { background: #e36b6b; }
      .panel {
        position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
        width: min(380px, calc(100vw - 16px)); max-height: calc(100vh - 20px);
        overflow: hidden; border: 1px solid #59616e; border-radius: 6px;
        background: #171a20; box-shadow: 0 8px 28px rgba(0,0,0,.5);
        font-size: 12px;
      }
      .header { height: 42px; padding: 0 10px 0 12px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #353b45; }
      .brand { font-size: 14px; font-weight: 800; flex: 1; }
      .header-status { color: #aeb6c2; max-width: 220px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .icon-button { width: 30px; height: 30px; padding: 0; border: 1px solid #4b5360; border-radius: 5px; background: #242a33; color: #f6f7f8; }
      .host-bar { padding: 8px 10px; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px; border-bottom: 1px solid #353b45; }
      .tabs { padding: 7px 10px 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
      .tab { min-height: 30px; border: 1px solid #414955; border-radius: 4px 4px 0 0; background: #20252d; color: #b9c0ca; }
      .tab[aria-selected="true"] { color: #fff; background: #2d343e; border-bottom-color: #2d343e; }
      .body { max-height: calc(100vh - 137px); overflow: auto; background: #1d2229; border-top: 1px solid #414955; }
      .view { padding: 10px; }
      select, input {
        width: 100%; min-width: 0; height: 32px; padding: 0 8px; border: 1px solid #4b5360;
        border-radius: 4px; outline: none; background: #111419; color: #f6f7f8;
      }
      input:focus, select:focus { border-color: #69c77b; box-shadow: 0 0 0 2px rgba(105,199,123,.17); }
      label { display: grid; gap: 5px; color: #bfc6cf; min-width: 0; }
      .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
      .span-2 { grid-column: 1 / -1; }
      .actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
      .button { min-height: 31px; padding: 0 11px; border: 1px solid #4b5360; border-radius: 4px; background: #2a3039; color: #f6f7f8; }
      .button:hover:not(:disabled), .icon-button:hover:not(:disabled), .tab:hover { background: #353d48; }
      .button.primary { border-color: #5cae6b; background: #3f8e50; }
      .button.primary:hover:not(:disabled) { background: #4a9f5c; }
      .button.danger { color: #ffb9b9; border-color: #70464a; }
      .empty { padding: 24px 10px; text-align: center; color: #929ca9; }
      .session-list { display: grid; }
      .session { padding: 10px 2px; border-bottom: 1px solid #343a44; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; }
      .session:last-child { border-bottom: 0; }
      .session-name { font-size: 13px; font-weight: 800; overflow-wrap: anywhere; }
      .session-meta { margin-top: 3px; color: #99a3af; line-height: 1.35; overflow-wrap: anywhere; }
      .session-state { display: inline-flex; align-items: center; gap: 5px; color: #d7dce2; }
      .session-state::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: #e9b949; }
      .session-state.live::before { background: #69c77b; }
      .session-actions { display: flex; gap: 5px; }
      .session-actions .button { padding: 0 8px; }
      .message { min-height: 18px; margin-top: 8px; color: #9ea8b5; line-height: 1.4; overflow-wrap: anywhere; }
      .message[data-tone="bad"] { color: #ff9d9d; }
      .message[data-tone="good"] { color: #8dda9c; }
      .host-list { margin-bottom: 10px; display: grid; gap: 5px; }
      .host-item { min-height: 34px; padding: 0 9px; border: 1px solid #414955; border-radius: 4px; background: #222831; color: #f6f7f8; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .host-item[aria-current="true"] { border-color: #69c77b; }
      dialog { width: min(330px, calc(100vw - 28px)); padding: 0; border: 1px solid #59616e; border-radius: 6px; background: #1a1e24; color: #f6f7f8; }
      dialog::backdrop { background: rgba(0,0,0,.62); }
      .dialog-body { padding: 14px; display: grid; gap: 10px; }
      .dialog-title { margin: 0; font-size: 15px; }
      .dialog-message { color: #aeb7c2; line-height: 1.4; overflow-wrap: anywhere; }
      @media (max-width: 520px) {
        .header-status { max-width: 150px; }
        .form-grid { grid-template-columns: 1fr; }
        .span-2 { grid-column: auto; }
        .session { grid-template-columns: 1fr; }
        .session-actions { justify-content: flex-end; }
      }
      @media (prefers-reduced-motion: no-preference) {
        .panel, .launcher { animation: dandelion-in .12s ease-out; }
        @keyframes dandelion-in { from { opacity: 0; transform: translateX(-50%) translateY(-4px); } }
      }
    </style>
    <button class="launcher" type="button" title="Dandelion" aria-label="Open Dandelion">
      D<span class="dot" data-role="dot"></span>
    </button>
    <section class="panel" aria-label="Dandelion session saver">
      <header class="header">
        <span class="brand">Dandelion</span>
        <span class="header-status" data-role="header-status"></span>
        <button class="icon-button" type="button" data-action="collapse" title="Hide" aria-label="Hide">-</button>
      </header>
      <div class="host-bar">
        <select data-role="host-select" aria-label="Dandelion host"></select>
        <button class="button" type="button" data-action="refresh">Refresh</button>
      </div>
      <nav class="tabs" aria-label="Dandelion views">
        <button class="tab" type="button" data-tab="sessions">Sessions</button>
        <button class="tab" type="button" data-tab="create">Create</button>
        <button class="tab" type="button" data-tab="hosts">Hosts</button>
      </nav>
      <div class="body">
        <section class="view" data-view="sessions">
          <div class="session-list" data-role="session-list"></div>
          <div class="message" data-role="sessions-message"></div>
        </section>
        <section class="view" data-view="create">
          <form data-role="create-form">
            <div class="form-grid">
              <label class="span-2">Session name<input name="sessionName" maxlength="29" required></label>
              <label class="span-2">Game server<select name="serverId" required></select></label>
              <label>Party share key<input name="psk" maxlength="20" autocomplete="off"></label>
              <label>Password<input name="password" type="password" minlength="8" maxlength="32" autocomplete="new-password"></label>
            </div>
            <div class="actions">
              <button class="button primary" type="submit">Create &amp; attach</button>
            </div>
            <div class="message" data-role="create-message"></div>
          </form>
        </section>
        <section class="view" data-view="hosts">
          <div class="host-list" data-role="host-list"></div>
          <form data-role="host-form">
            <div class="form-grid">
              <label>Host name<input name="name" maxlength="40" required></label>
              <label>Base URL<input name="url" type="url" required></label>
            </div>
            <div class="actions">
              <button class="button" type="button" data-action="new-host">New</button>
              <button class="button danger" type="button" data-action="remove-host">Remove</button>
              <button class="button primary" type="submit">Save host</button>
            </div>
            <div class="message" data-role="hosts-message"></div>
          </form>
        </section>
      </div>
    </section>
    <dialog data-role="password-dialog">
      <form class="dialog-body" method="dialog" data-role="password-form">
        <h2 class="dialog-title" data-role="password-title">Session password</h2>
        <div class="dialog-message" data-role="password-message"></div>
        <input name="password" type="password" minlength="8" maxlength="32" autocomplete="current-password" required aria-label="Session password">
        <div class="actions">
          <button class="button" type="button" data-action="cancel-password">Cancel</button>
          <button class="button primary" type="submit">Continue</button>
        </div>
      </form>
    </dialog>
  `;

  const ui = {
    launcher: shadow.querySelector(".launcher"),
    panel: shadow.querySelector(".panel"),
    dot: shadow.querySelector('[data-role="dot"]'),
    headerStatus: shadow.querySelector('[data-role="header-status"]'),
    hostSelect: shadow.querySelector('[data-role="host-select"]'),
    sessionList: shadow.querySelector('[data-role="session-list"]'),
    sessionsMessage: shadow.querySelector('[data-role="sessions-message"]'),
    createForm: shadow.querySelector('[data-role="create-form"]'),
    createMessage: shadow.querySelector('[data-role="create-message"]'),
    serverSelect: shadow.querySelector('[name="serverId"]'),
    hostList: shadow.querySelector('[data-role="host-list"]'),
    hostForm: shadow.querySelector('[data-role="host-form"]'),
    hostsMessage: shadow.querySelector('[data-role="hosts-message"]'),
    passwordDialog: shadow.querySelector('[data-role="password-dialog"]'),
    passwordForm: shadow.querySelector('[data-role="password-form"]'),
    passwordTitle: shadow.querySelector('[data-role="password-title"]'),
    passwordMessage: shadow.querySelector('[data-role="password-message"]'),
  };

  for (const type of [
    "pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick",
    "keydown", "keyup", "keypress", "wheel", "contextmenu",
  ]) {
    host.addEventListener(type, (event) => event.stopPropagation());
  }

  ui.launcher.addEventListener("click", () => setCollapsed(false));
  shadow.querySelector('[data-action="collapse"]').addEventListener("click", () => setCollapsed(true));
  shadow.querySelector('[data-action="refresh"]').addEventListener("click", () => void refreshSessions());
  shadow.querySelector('[data-action="new-host"]').addEventListener("click", startNewHost);
  shadow.querySelector('[data-action="remove-host"]').addEventListener("click", removeHost);
  shadow.querySelector('[data-action="cancel-password"]').addEventListener("click", () => finishPasswordPrompt(null));
  ui.hostSelect.addEventListener("change", onHostChanged);
  ui.createForm.addEventListener("submit", onCreateSession);
  ui.createForm.addEventListener("input", rememberCreateForm);
  ui.hostForm.addEventListener("submit", saveHost);
  ui.passwordForm.addEventListener("submit", onPasswordSubmit);
  ui.passwordDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finishPasswordPrompt(null);
  });
  for (const tab of shadow.querySelectorAll("[data-tab]")) {
    tab.addEventListener("click", () => setTab(tab.dataset.tab));
  }

  pageWindow.addEventListener("beforeunload", (event) => {
    if (!state.activeAttachment) return;
    event.stopImmediatePropagation();
  }, true);

  renderHosts();
  setTab(settings.activeTab);
  setCollapsed(settings.collapsed);
  updateStatus("idle", "Waiting for client");
  discoverClient();
  state.refreshTimer = pageWindow.setInterval(() => {
    if (!settings.collapsed && settings.activeTab === "sessions") void refreshSessions(true);
  }, 5000);

  function loadSettings() {
    let stored = null;
    try {
      const value = typeof GM_getValue === "function"
        ? GM_getValue(STORAGE_KEY, null)
        : pageWindow.localStorage.getItem(STORAGE_KEY);
      stored = typeof value === "string" ? JSON.parse(value) : value;
    } catch (_) {
      stored = null;
    }

    const hosts = Array.isArray(stored?.hosts)
      ? stored.hosts.filter(isStoredHost)
      : [];
    if (hosts.length === 0) hosts.push({ ...DEFAULT_HOST });
    const selectedHostId = hosts.some((item) => item.id === stored?.selectedHostId)
      ? stored.selectedHostId
      : hosts[0].id;

    return {
      hosts,
      selectedHostId,
      collapsed: Boolean(stored?.collapsed),
      activeTab: ["sessions", "create", "hosts"].includes(stored?.activeTab)
        ? stored.activeTab
        : "sessions",
      sessionName: typeof stored?.sessionName === "string" ? stored.sessionName.slice(0, 29) : "",
      psk: typeof stored?.psk === "string" ? stored.psk.slice(0, 20) : "",
      serverId: typeof stored?.serverId === "string" ? stored.serverId : "",
      lastSessionByHost: stored?.lastSessionByHost && typeof stored.lastSessionByHost === "object"
        ? stored.lastSessionByHost
        : {},
    };
  }

  function isStoredHost(item) {
    return item && typeof item.id === "string" && typeof item.name === "string" && typeof item.url === "string";
  }

  function saveSettings() {
    const serialized = JSON.stringify(settings);
    try {
      if (typeof GM_setValue === "function") GM_setValue(STORAGE_KEY, serialized);
      else pageWindow.localStorage.setItem(STORAGE_KEY, serialized);
    } catch (_) {}
  }

  function getSelectedHost() {
    return settings.hosts.find((item) => item.id === settings.selectedHostId) || settings.hosts[0];
  }

  function setCollapsed(collapsed) {
    settings.collapsed = Boolean(collapsed);
    ui.launcher.hidden = !settings.collapsed;
    ui.panel.hidden = settings.collapsed;
    saveSettings();
    if (!settings.collapsed && settings.activeTab === "sessions") void refreshSessions(true);
  }

  function setTab(tabName) {
    const name = ["sessions", "create", "hosts"].includes(tabName) ? tabName : "sessions";
    settings.activeTab = name;
    for (const tab of shadow.querySelectorAll("[data-tab]")) {
      tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
    }
    for (const view of shadow.querySelectorAll("[data-view]")) {
      view.hidden = view.dataset.view !== name;
    }
    if (name === "hosts") loadHostDraft(settings.selectedHostId);
    if (name === "sessions") void refreshSessions(true);
    saveSettings();
  }

  function updateStatus(tone, text) {
    state.status = { tone, text };
    ui.dot.dataset.tone = tone;
    ui.headerStatus.textContent = text;
  }

  function setMessage(element, text, tone = "idle") {
    element.textContent = text || "";
    element.dataset.tone = tone;
  }

  function renderHosts() {
    ui.hostSelect.replaceChildren();
    ui.hostList.replaceChildren();
    for (const item of settings.hosts) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.name;
      option.selected = item.id === settings.selectedHostId;
      ui.hostSelect.appendChild(option);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "host-item";
      button.textContent = `${item.name} - ${item.url}`;
      button.setAttribute("aria-current", String(item.id === state.hostDraftId));
      button.addEventListener("click", () => loadHostDraft(item.id));
      ui.hostList.appendChild(button);
    }
  }

  function onHostChanged() {
    settings.selectedHostId = ui.hostSelect.value;
    state.hostDraftId = settings.selectedHostId;
    settings.activeTab = "sessions";
    state.sessions = [];
    saveSettings();
    renderHosts();
    setTab("sessions");
    void refreshSessions();
  }

  function loadHostDraft(id) {
    const item = settings.hosts.find((hostItem) => hostItem.id === id);
    state.hostDraftId = item?.id || null;
    ui.hostForm.elements.name.value = item?.name || "";
    ui.hostForm.elements.url.value = item?.url || "";
    setMessage(ui.hostsMessage, "");
    renderHosts();
  }

  function startNewHost() {
    state.hostDraftId = null;
    ui.hostForm.reset();
    setMessage(ui.hostsMessage, "");
    renderHosts();
    ui.hostForm.elements.name.focus();
  }

  function saveHost(event) {
    event.preventDefault();
    const data = new FormData(ui.hostForm);
    const name = String(data.get("name") || "").trim();
    let url;
    try {
      url = normalizeHostUrl(String(data.get("url") || ""));
    } catch (error) {
      setMessage(ui.hostsMessage, error.message, "bad");
      return;
    }
    if (!name) {
      setMessage(ui.hostsMessage, "Host name is required", "bad");
      return;
    }

    let id = state.hostDraftId;
    const existing = settings.hosts.find((item) => item.id === id);
    if (existing) {
      existing.name = name.slice(0, 40);
      existing.url = url;
    } else {
      id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `host-${Date.now()}`;
      settings.hosts.push({ id, name: name.slice(0, 40), url });
    }
    settings.selectedHostId = id;
    state.hostDraftId = id;
    saveSettings();
    renderHosts();
    loadHostDraft(id);
    setMessage(ui.hostsMessage, "Host saved", "good");
  }

  function removeHost() {
    if (!state.hostDraftId) return;
    if (settings.hosts.length === 1) {
      setMessage(ui.hostsMessage, "At least one host is required", "bad");
      return;
    }
    const item = settings.hosts.find((hostItem) => hostItem.id === state.hostDraftId);
    if (!item || !pageWindow.confirm(`Remove ${item.name}?`)) return;
    settings.hosts = settings.hosts.filter((hostItem) => hostItem.id !== item.id);
    delete settings.lastSessionByHost[item.id];
    if (settings.selectedHostId === item.id) settings.selectedHostId = settings.hosts[0].id;
    state.hostDraftId = settings.selectedHostId;
    saveSettings();
    renderHosts();
    loadHostDraft(state.hostDraftId);
  }

  function normalizeHostUrl(input) {
    let url;
    try {
      url = new URL(input.trim());
    } catch (_) {
      throw new Error("Enter a valid HTTP or HTTPS URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Host URL must use HTTP or HTTPS");
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("Host URL cannot include credentials, query, or fragment");
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  }

  async function refreshSessions(silent = false) {
    const selected = getSelectedHost();
    if (!selected) return;
    if (!silent) {
      setMessage(ui.sessionsMessage, "Loading sessions");
      updateStatus("busy", "Loading sessions");
    }
    try {
      const result = await apiRequest(selected, "GET", "/get-sessions");
      if (!Array.isArray(result)) throw new Error("Host returned an invalid session list");
      state.sessions = result.filter(isSession).sort(compareSessions);
      renderSessions();
      setMessage(ui.sessionsMessage, state.sessions.length ? "" : "No active sessions");
      if (!state.activeAttachment && !silent) updateStatus("good", `${selected.name} online`);
    } catch (error) {
      if (!silent) {
        setMessage(ui.sessionsMessage, error.message, "bad");
        updateStatus("bad", "Host unavailable");
      }
    }
  }

  function isSession(item) {
    return item && typeof item.sessionId === "string" && typeof item.sessionName === "string" && typeof item.status === "string";
  }

  function compareSessions(a, b) {
    const statusDifference = Number(b.status === "in-world") - Number(a.status === "in-world");
    if (statusDifference) return statusDifference;
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  }

  function renderSessions() {
    ui.sessionList.replaceChildren();
    if (state.sessions.length === 0) return;
    for (const session of state.sessions) {
      const row = document.createElement("div");
      row.className = "session";

      const detail = document.createElement("div");
      const name = document.createElement("div");
      name.className = "session-name";
      name.textContent = session.sessionName;
      const meta = document.createElement("div");
      meta.className = "session-meta";
      const ping = Number.isFinite(session.ping) ? ` - ${Math.round(session.ping)} ms` : "";
      meta.textContent = `${session.serverId || session.hostname || "Unknown server"}${ping}`;
      const sessionState = document.createElement("span");
      sessionState.className = `session-state${session.status === "in-world" ? " live" : ""}`;
      sessionState.textContent = session.status;
      detail.append(name, meta, sessionState);

      const actions = document.createElement("div");
      actions.className = "session-actions";
      const isActive = state.activeAttachment?.session.sessionId === session.sessionId;
      const attach = document.createElement("button");
      attach.type = "button";
      attach.className = isActive ? "button" : "button primary";
      attach.textContent = isActive ? "Detach" : "Attach";
      attach.disabled = !isActive && (session.status !== "in-world" || !state.game);
      attach.addEventListener("click", () => {
        if (isActive) detachClient();
        else void attachSession(session);
      });
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "button danger";
      stop.textContent = "Stop";
      stop.addEventListener("click", () => void stopSession(session));
      actions.append(attach, stop);
      row.append(detail, actions);
      ui.sessionList.appendChild(row);
    }
  }

  function rememberCreateForm() {
    settings.sessionName = ui.createForm.elements.sessionName.value.slice(0, 29);
    settings.psk = ui.createForm.elements.psk.value.slice(0, 20);
    settings.serverId = ui.createForm.elements.serverId.value;
    saveSettings();
  }

  async function onCreateSession(event) {
    event.preventDefault();
    if (!state.game) {
      setMessage(ui.createMessage, "Compatible ZOMBS client not found", "bad");
      return;
    }
    const data = new FormData(ui.createForm);
    const sessionName = String(data.get("sessionName") || "").trim();
    const psk = String(data.get("psk") || "").trim();
    const password = String(data.get("password") || "");
    const server = getGameServers()[String(data.get("serverId") || "")];
    if (!server) {
      setMessage(ui.createMessage, "Select a valid game server", "bad");
      return;
    }
    if (!sessionName || sessionName.length > 29) {
      setMessage(ui.createMessage, "Session name must be 1 to 29 characters", "bad");
      return;
    }
    if (psk && !/^[a-zA-Z]{20}$/.test(psk)) {
      setMessage(ui.createMessage, "Party share key must be 20 letters", "bad");
      return;
    }
    if (password && (password.length < 8 || password.length > 32)) {
      setMessage(ui.createMessage, "Password must be 8 to 32 characters", "bad");
      return;
    }

    rememberCreateForm();
    const submit = ui.createForm.querySelector('[type="submit"]');
    submit.disabled = true;
    updateStatus("busy", "Creating session");
    setMessage(ui.createMessage, "Creating session");
    try {
      const selectedHost = getSelectedHost();
      const payload = {
        sessionName,
        id: server.id,
        hostname: server.hostname,
        ipAddress: server.ipAddress,
        plugins: [],
      };
      if (psk) payload.psk = psk;
      if (password) payload.password = password;
      const result = await apiRequest(selectedHost, "POST", "/create-session", payload);
      if (!result?.sessionId) throw new Error("Host did not return a session id");
      settings.lastSessionByHost[selectedHost.id] = result.sessionId;
      saveSettings();
      ui.createForm.elements.password.value = "";
      setMessage(ui.createMessage, "Waiting for session to enter the world");
      const session = await waitForSession(selectedHost, result.sessionId);
      await attachSession(session, password || undefined);
    } catch (error) {
      setMessage(ui.createMessage, error.message, "bad");
      updateStatus("bad", "Create failed");
    } finally {
      submit.disabled = false;
      ui.createForm.elements.password.value = "";
    }
  }

  async function waitForSession(selectedHost, sessionId) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const sessions = await apiRequest(selectedHost, "GET", "/get-sessions");
      if (!Array.isArray(sessions)) throw new Error("Host returned an invalid session list");
      state.sessions = sessions.filter(isSession).sort(compareSessions);
      renderSessions();
      const session = state.sessions.find((item) => item.sessionId === sessionId);
      if (session?.status === "in-world") return session;
      if (session) setMessage(ui.createMessage, `Session status: ${session.status}`);
      await new Promise((resolve) => pageWindow.setTimeout(resolve, 750));
    }
    throw new Error("Session did not become ready in time");
  }

  async function attachSession(session, password) {
    if (!state.game || session.status !== "in-world") return;
    const selectedHost = { ...getSelectedHost() };
    const target = {
      id: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : String(Date.now()),
      host: selectedHost,
      session: { ...session },
      serverOptions: makeServerOptions(session),
      password,
      awaitingPassword: false,
      checkInitialDeath: false,
      everInWorld: false,
      attempt: 0,
    };
    state.activeAttachment = target;
    settings.lastSessionByHost[selectedHost.id] = session.sessionId;
    saveSettings();
    setMessage(ui.sessionsMessage, "");
    updateStatus("busy", `Attaching ${session.sessionName}`);
    renderSessions();

    if (state.game.ui?.setOption) {
      state.game.ui.setOption("nickname", session.sessionName);
      state.game.ui.setOption("serverId", session.serverId);
    }

    const socket = state.network.socket;
    if (socket && socket.readyState < nativeWebSocket.CLOSING) {
      socket.addEventListener("close", () => {
        if (state.activeAttachment === target) {
          state.network.connecting = false;
          state.network.connect(target.serverOptions);
        }
      }, { once: true });
      socket.close(1000, "Switching to Dandelion");
    } else {
      state.network.connecting = false;
      state.network.connect(target.serverOptions);
    }
  }

  function detachClient() {
    if (!state.activeAttachment) return;
    updateStatus("busy", "Detaching client");
    pageWindow.location.reload();
  }

  function makeServerOptions(session) {
    const known = getGameServers()[session.serverId];
    const options = known ? { ...known } : {
      id: session.serverId,
      name: session.serverId,
      hostname: session.hostname,
      ipAddress: session.ipAddress,
      port: 443,
    };
    delete options.fallbackPort;
    return options;
  }

  async function stopSession(session) {
    if (!pageWindow.confirm(`Stop ${session.sessionName}? This ends the saved session.`)) return;
    const selectedHost = getSelectedHost();
    updateStatus("busy", `Stopping ${session.sessionName}`);
    try {
      try {
        await apiRequest(selectedHost, "DELETE", `/sessions/${encodeURIComponent(session.sessionId)}`);
      } catch (error) {
        if (error.status !== 401) throw error;
        const activePassword = state.activeAttachment?.session.sessionId === session.sessionId
          ? state.activeAttachment.password
          : undefined;
        const password = activePassword || await promptForPassword(session.sessionName, error.message);
        if (!password) {
          updateStatus("idle", "Stop cancelled");
          return;
        }
        const token = await requestAuthToken(selectedHost, session.sessionId, password);
        await apiRequest(selectedHost, "DELETE", `/sessions/${encodeURIComponent(session.sessionId)}?token=${encodeURIComponent(token)}`);
      }
      if (state.activeAttachment?.session.sessionId === session.sessionId) {
        pageWindow.location.reload();
        return;
      }
      updateStatus("good", "Session stopped");
      await refreshSessions(true);
    } catch (error) {
      updateStatus("bad", "Stop failed");
      setMessage(ui.sessionsMessage, error.message, "bad");
    }
  }

  function discoverClient() {
    const game = findGame();
    if (!game) {
      state.clientTimer = pageWindow.setTimeout(discoverClient, 250);
      return;
    }
    state.game = game;
    state.network = game.network;
    installNetworkBridge();
    populateCreateForm();
    updateStatus("good", "Client ready");
    renderSessions();
    void refreshSessions(true);
  }

  function findGame() {
    const candidates = [pageWindow.game, pageWindow.Game?.currentGame];
    try {
      candidates.push(pageWindow.eval("typeof game !== 'undefined' ? game : null"));
    } catch (_) {}
    return candidates.find((candidate) =>
      candidate?.network && candidate?.ui && candidate?.world &&
      candidate?.options?.servers &&
      typeof candidate.network.connect === "function" &&
      typeof candidate.network.sendEnterWorld === "function" &&
      typeof candidate.network.bindEventListeners === "function" &&
      typeof candidate.network.addConnectHandler === "function" &&
      typeof candidate.network.addEnterWorldHandler === "function"
    ) || null;
  }

  function getGameServers() {
    return state.game?.options?.servers || {};
  }

  function populateCreateForm() {
    const servers = getGameServers();
    ui.serverSelect.replaceChildren();
    for (const [id, server] of Object.entries(servers)) {
      if (!server?.hostname || !server?.ipAddress) continue;
      const option = document.createElement("option");
      option.value = id;
      option.textContent = server.name || id;
      ui.serverSelect.appendChild(option);
    }
    const selectedServerId = Object.values(servers).find((server) => server?.selected)?.id;
    const defaultServerId = settings.serverId || selectedServerId || Object.keys(servers)[0];
    if (defaultServerId && servers[defaultServerId]) ui.serverSelect.value = defaultServerId;
    const introName = document.querySelector(".hud-intro-name")?.value || readPageStorage("name") || "";
    ui.createForm.elements.sessionName.value = settings.sessionName || introName.slice(0, 29);
    ui.createForm.elements.psk.value = settings.psk;
  }

  function installNetworkBridge() {
    const network = state.network;
    if (network.__dandelionBridge) return;
    const originalConnect = network.connect.bind(network);
    const originalReconnect = network.reconnect?.bind(network);

    Object.defineProperty(network, "__dandelionBridge", {
      value: { originalConnect, originalReconnect },
      configurable: false,
      enumerable: false,
    });

    network.connect = function dandelionConnect(options) {
      const target = state.activeAttachment;
      if (!target) return originalConnect(options);
      if (target.awaitingPassword || this.connecting) return;
      return void openDandelionSocket(this, target, options || target.serverOptions);
    };

    network.reconnect = function dandelionReconnect() {
      const target = state.activeAttachment;
      if (!target) return originalReconnect?.();
      if (target.awaitingPassword) return;
      if (this.socket && this.socket.readyState <= nativeWebSocket.OPEN) return;
      return this.connect(target.serverOptions);
    };

    network.addConnectHandler(() => {
      const target = state.activeAttachment;
      const socket = network.socket;
      if (!target || socket !== target.socket) return;
      updateStatus("busy", "Syncing session");
      if (socket.readyState === nativeWebSocket.OPEN) {
        network.sendEnterWorld({
          displayName: target.session.sessionName,
          extra: new ArrayBuffer(0),
        });
      }
    });

    state.game.ui.on?.("playerTickUpdate", (playerTick) => {
      const target = state.activeAttachment;
      if (!target?.checkInitialDeath || network.socket !== target.socket) return;
      target.checkInitialDeath = false;
      if (playerTick?.dead !== 1) return;

      network.emitter?.emit("PACKET_RPC", {
        name: "Dead",
        response: { stashDied: 0 },
      });
    });

    network.addEnterWorldHandler((data) => {
      const target = state.activeAttachment;
      if (!target || network.socket !== target.socket || !data?.allowed) return;
      target.checkInitialDeath = true;
      target.everInWorld = true;
      target.awaitingPassword = false;
      target.retryDelay = 1000;
      updateStatus("good", `Attached to ${target.session.sessionName}`);
      renderSessions();
      pageWindow.setTimeout(() => {
        if (state.activeAttachment === target) setCollapsed(true);
      }, 650);
    });
  }

  async function openDandelionSocket(network, target, options) {
    network.connectionOptions = { ...options };
    delete network.connectionOptions.fallbackPort;
    network.connected = false;
    network.connecting = true;
    target.serverOptions = network.connectionOptions;
    target.attempt += 1;
    const attempt = target.attempt;

    try {
      const token = target.password
        ? await requestAuthToken(target.host, target.session.sessionId, target.password)
        : null;
      if (state.activeAttachment !== target || target.attempt !== attempt) return;
      const socket = new nativeWebSocket(makeWebSocketUrl(target.host, target.session.sessionId, token));
      target.socket = socket;
      socket.binaryType = "arraybuffer";
      network.socket = socket;
      network.pingStart = null;
      network.pingCompletion = null;
      network.bindEventListeners();
      socket.addEventListener("close", (event) => void onDandelionClose(target, event));
      updateStatus("busy", `Connecting to ${target.host.name}`);
    } catch (error) {
      network.connecting = false;
      network.connected = false;
      if (state.activeAttachment !== target) return;
      if (target.everInWorld) {
        updateStatus("busy", "Reconnect delayed");
        scheduleReconnect(target);
        return;
      }
      if (target.password && [401, 404, 429].includes(error.status)) {
        target.password = undefined;
        await requestPasswordAndRetry(target, error.message);
        return;
      }
      state.activeAttachment = null;
      renderSessions();
      updateStatus("bad", "Attach failed");
      setMessage(ui.sessionsMessage, error.message, "bad");
    }
  }

  async function onDandelionClose(target, event) {
    if (state.activeAttachment !== target) return;
    state.network.connecting = false;
    state.network.connected = false;
    if (!target.everInWorld && event.code === 1008 && !target.password) {
      await requestPasswordAndRetry(target, "Password required");
      return;
    }
    if (target.everInWorld) {
      updateStatus("busy", "Reconnecting session");
      scheduleReconnect(target);
      return;
    }
    state.activeAttachment = null;
    renderSessions();
    updateStatus("bad", `Connection closed (${event.code})`);
  }

  function scheduleReconnect(target) {
    const delay = Math.min(target.retryDelay || 1000, 10000);
    target.retryDelay = Math.min(delay * 2, 10000);
    pageWindow.setTimeout(() => {
      if (state.activeAttachment !== target || target.awaitingPassword) return;
      const socket = state.network.socket;
      if (state.network.connecting || (socket && socket.readyState <= nativeWebSocket.OPEN)) return;
      state.network.reconnect();
    }, delay);
  }

  async function requestPasswordAndRetry(target, message) {
    if (state.activeAttachment !== target || target.awaitingPassword) return;
    target.awaitingPassword = true;
    updateStatus("busy", "Password required");
    const password = await promptForPassword(target.session.sessionName, message);
    if (state.activeAttachment !== target) return;
    target.awaitingPassword = false;
    if (!password) {
      state.activeAttachment = null;
      renderSessions();
      updateStatus("idle", "Attach cancelled");
      if (state.game.world?.getInWorld?.()) pageWindow.location.reload();
      return;
    }
    target.password = password;
    state.network.connecting = false;
    state.network.connect(target.serverOptions);
  }

  function promptForPassword(sessionName, message = "") {
    if (state.passwordResolver) finishPasswordPrompt(null);
    ui.passwordTitle.textContent = sessionName;
    ui.passwordMessage.textContent = message;
    ui.passwordForm.elements.password.value = "";
    ui.passwordDialog.showModal();
    pageWindow.setTimeout(() => ui.passwordForm.elements.password.focus(), 0);
    return new Promise((resolve) => {
      state.passwordResolver = resolve;
    });
  }

  function onPasswordSubmit(event) {
    event.preventDefault();
    const password = ui.passwordForm.elements.password.value;
    if (password.length < 8 || password.length > 32) return;
    finishPasswordPrompt(password);
  }

  function finishPasswordPrompt(password) {
    const resolve = state.passwordResolver;
    state.passwordResolver = null;
    ui.passwordForm.elements.password.value = "";
    if (ui.passwordDialog.open) ui.passwordDialog.close();
    resolve?.(password);
  }

  async function requestAuthToken(selectedHost, sessionId, password) {
    const result = await apiRequest(
      selectedHost,
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/auth`,
      { password },
    );
    if (!result?.token) throw new Error("Host did not return an auth token");
    return result.token;
  }

  function makeWebSocketUrl(selectedHost, sessionId, token) {
    const url = new URL(selectedHost.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/sessions/${encodeURIComponent(sessionId)}`;
    url.search = "";
    url.hash = "";
    if (token) url.searchParams.set("token", token);
    return url.toString();
  }

  function readPageStorage(key) {
    try {
      return pageWindow.localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function apiRequest(selectedHost, method, path, body) {
    const url = `${selectedHost.url.replace(/\/+$/, "")}${path}`;
    if (typeof GM_xmlhttpRequest !== "function") return fetchRequest(url, method, body);
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: body ? { "content-type": "application/json" } : undefined,
        data: body ? JSON.stringify(body) : undefined,
        timeout: 10000,
        onload: (response) => settleResponse(response.status, response.responseText, resolve, reject),
        onerror: () => reject(new Error(`Could not reach ${selectedHost.name}`)),
        ontimeout: () => reject(new Error(`${selectedHost.name} timed out`)),
      });
    });
  }

  async function fetchRequest(url, method, body) {
    let response;
    try {
      response = await pageWindow.fetch(url, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (_) {
      throw new Error("Host request failed");
    }
    const text = await response.text();
    return new Promise((resolve, reject) => settleResponse(response.status, text, resolve, reject));
  }

  function settleResponse(status, text, resolve, reject) {
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = text;
    }
    if (status >= 200 && status < 300) {
      resolve(data);
      return;
    }
    const error = new Error(
      typeof data?.error === "string"
        ? data.error
        : typeof data === "string" && data
          ? data
          : `Host request failed (${status})`,
    );
    error.status = status;
    reject(error);
  }
})();
