/* Daily WebCrypto AES-256-GCM End-to-End Encrypted Vault Sync (byte-compatible with daily/e2ee.py).
 * Works directly on mobile data (iOS Safari, Android Chrome, Tablet, Capacitor) with ZERO custom server.
 * Pairing uses URL hash fragments (#e2ee=...) so the 256-bit key is never sent in HTTP requests/logs.
 */
(function () {
  const CFG_KEY = "daily_e2ee_cfg_v1";
  const AAD_STR = "daily-e2ee-v1";
  const VAULT_FILENAME = "daily-e2ee-vault.json";

  function b64uEnc(bytes) {
    let bin = "";
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64uDec(str) {
    const norm = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
    const pad = "=".repeat((4 - (norm.length % 4)) % 4);
    const bin = atob(norm + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function getSubtle() {
    const c = (typeof globalThis !== "undefined" && globalThis.crypto) || window.crypto;
    if (!c || !c.subtle) throw new Error("WebCrypto AES-GCM erfordert HTTPS oder localhost");
    return c;
  }

  function generateKeyB64u() {
    const c = getSubtle();
    const raw = new Uint8Array(32);
    c.getRandomValues(raw);
    return b64uEnc(raw);
  }

  async function encryptPayload(payloadObj, keyB64u) {
    const c = getSubtle();
    const keyBytes = b64uDec(keyB64u.trim());
    if (keyBytes.length !== 32) throw new Error("E2EE-Schlüssel muss 256 Bit lang sein");
    const cryptoKey = await c.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
    const iv = new Uint8Array(12);
    c.getRandomValues(iv);
    const enc = new TextEncoder();
    const plaintext = enc.encode(JSON.stringify(payloadObj));
    const aad = enc.encode(AAD_STR);
    const ctBuf = await c.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, cryptoKey, plaintext);
    return {
      v: 1,
      alg: "AES-256-GCM",
      aad: AAD_STR,
      iv: b64uEnc(iv),
      ct: b64uEnc(new Uint8Array(ctBuf)),
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    };
  }

  async function decryptPayload(envelope, keyB64u) {
    if (!envelope || envelope.alg !== "AES-256-GCM") throw new Error("Ungültiges E2EE-Tresor-Format");
    const c = getSubtle();
    const keyBytes = b64uDec(keyB64u.trim());
    if (keyBytes.length !== 32) throw new Error("Ungültige E2EE-Schlüssellänge");
    const cryptoKey = await c.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
    const iv = b64uDec(envelope.iv);
    const ct = b64uDec(envelope.ct);
    const aad = new TextEncoder().encode(envelope.aad || AAD_STR);
    try {
      const plainBuf = await c.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, cryptoKey, ct);
      return JSON.parse(new TextDecoder().decode(plainBuf));
    } catch {
      throw new Error("Schlüssel passt nicht zum Tresor (wurde evtl. erneuert — bitte aktuellen Koppel-Link nutzen)");
    }
  }

  function loadCfg() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CFG_KEY) || "null");
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
    return { enabled: false, provider: "gist", gist_id: "", endpoint_url: "", auth_token: "", key_b64u: "", last_sync_at: "" };
  }

  function saveCfg(patch) {
    const next = { ...loadCfg(), ...patch };
    localStorage.setItem(CFG_KEY, JSON.stringify(next));
    return next;
  }

  function buildPairingUrl(cfg, baseUrl) {
    if (!cfg || !cfg.key_b64u) return "";
    const compact = {
      k: cfg.key_b64u,
      v: 1,
      p: cfg.provider || "gist",
      t: cfg.auth_token || "",
    };
    if (compact.p === "gist") compact.g = cfg.gist_id || "";
    else compact.u = cfg.endpoint_url || "";
    const encoded = b64uEnc(new TextEncoder().encode(JSON.stringify(compact)));
    const base = (baseUrl || "https://daily.aethelburg.network").replace(/\/+$/, "");
    return `${base}/#e2ee=${encoded}`;
  }

  function parsePairingString(rawStr) {
    try {
      const m = String(rawStr || "").trim().match(/e2ee(?:=|%3D)([A-Za-z0-9_-]+)/i);
      if (!m) return null;
      const decoded = JSON.parse(new TextDecoder().decode(b64uDec(m[1])));
      if (!decoded || !decoded.k) return null;
      return {
        enabled: true,
        provider: decoded.p || "gist",
        key_b64u: decoded.k,
        auth_token: decoded.t || "",
        gist_id: decoded.g || "",
        endpoint_url: decoded.u || "",
      };
    } catch {
      return null;
    }
  }

  function captureHashPairing() {
    try {
      const parsed = parsePairingString(window.location.hash || "");
      if (!parsed) return null;
      // Clear any stale custom LAN server override on static hosts so standalone E2EE takes over cleanly
      if (window.location && (window.location.hostname.endsWith("aethelburg.network") || window.location.hostname.endsWith("github.io"))) {
        localStorage.removeItem("daily_server_url");
      }
      const cfg = saveCfg(parsed);
      if (window.history && window.history.replaceState) {
        window.history.replaceState({}, "", window.location.pathname + window.location.search);
      }
      return cfg;
    } catch {
      return null;
    }
  }

  function mergeDatabases(localDb, remote) {
    const out = {
      ...localDb,
      habits: [...(localDb.habits || [])],
      edges: [...(localDb.edges || [])],
      events: [...(localDb.events || [])],
      snapshots: [...(localDb.snapshots || [])],
      state_dimensions: [...(localDb.state_dimensions || [])],
      settings: { ...(localDb.settings || {}) },
    };

    // 1. Habits (LWW on updated_at by id)
    const habById = Object.fromEntries(out.habits.map((h) => [h.id, h]));
    for (const rh of remote.habits || []) {
      if (!rh.id || !rh.name) continue;
      const rUpd = rh.updated_at || rh.created_at || "";
      const lh = habById[rh.id];
      if (!lh) {
        if (!out.habits.some((x) => x.name.toLowerCase() === rh.name.toLowerCase())) {
          const copy = { ...rh };
          out.habits.push(copy);
          habById[copy.id] = copy;
        }
      } else {
        const lUpd = lh.updated_at || lh.created_at || "";
        if (rUpd > lUpd) Object.assign(lh, rh);
      }
    }

    // 2. State dimensions (LWW on updated_at so axis colors & archived state sync across devices)
    const dimById = Object.fromEntries(out.state_dimensions.map((d) => [d.id, d]));
    for (const rd of remote.state_dimensions || []) {
      if (!rd.id || !rd.name) continue;
      const ld = dimById[rd.id];
      if (!ld) {
        const copy = { ...rd };
        out.state_dimensions.push(copy);
        dimById[rd.id] = copy;
      } else {
        const rUpd = rd.updated_at || rd.created_at || "";
        const lUpd = ld.updated_at || ld.created_at || "";
        if (rUpd > lUpd) {
          Object.assign(ld, rd, { color: rd.color || ld.color });
        }
      }
    }
    out.state_dimensions.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

    // 3. Edges (semantic key + LWW on updated_at)
    const edgeKey = (e) => `${e.source_id}::${e.target_id}::${e.relation_type || "rollup"}::${e.context_window || "any"}`;
    const edgeMap = Object.fromEntries(out.edges.map((e) => [edgeKey(e), e]));
    let maxId = out.next_id || 1;
    for (const re of remote.edges || []) {
      if (!habById[re.source_id] || !habById[re.target_id] || re.source_id === re.target_id) continue;
      const k = edgeKey(re);
      const le = edgeMap[k];
      const rUpd = re.updated_at || re.created_at || "";
      if (!le) {
        const copy = { ...re, id: maxId++ };
        out.edges.push(copy);
        edgeMap[k] = copy;
      } else if (rUpd > (le.updated_at || le.created_at || "")) {
        le.weight = Number(re.weight);
        le.note = re.note || "";
        le.updated_at = rUpd;
      }
    }

    // 4. Events (idempotent by client_uuid + LWW + deleted_at tombstones)
    const evByUuid = {};
    for (const ev of out.events) {
      if (ev.client_uuid) evByUuid[ev.client_uuid] = ev;
      if (ev.id >= maxId) maxId = ev.id + 1;
    }
    for (const rev of remote.events || []) {
      const cu = (rev.client_uuid || "").trim();
      if (!cu || !habById[rev.habit_id]) continue;
      const rUpd = rev.updated_at || rev.created_at || "";
      const lev = evByUuid[cu];
      if (!lev) {
        const copy = { ...rev, id: maxId++ };
        out.events.push(copy);
        evByUuid[cu] = copy;
      } else if (rUpd > (lev.updated_at || lev.created_at || "") || (rUpd === (lev.updated_at || lev.created_at || "") && rev.deleted_at && !lev.deleted_at)) {
        Object.assign(lev, { ...rev, id: lev.id });
      }
    }

    // 5. Snapshots (Momentaufnahmen — idempotent by client_uuid + tombstones)
    const snByUuid = {};
    for (const sn of out.snapshots) {
      if (sn.client_uuid) snByUuid[sn.client_uuid] = sn;
      if (sn.id >= maxId) maxId = sn.id + 1;
    }
    for (const rsn of remote.snapshots || []) {
      const cu = (rsn.client_uuid || "").trim();
      if (!cu) continue;
      const rUpd = rsn.updated_at || rsn.created_at || "";
      const lsn = snByUuid[cu];
      if (!lsn) {
        const copy = { ...rsn, id: maxId++ };
        out.snapshots.push(copy);
        snByUuid[cu] = copy;
      } else if (rUpd > (lsn.updated_at || lsn.created_at || "") || (rUpd === (lsn.updated_at || lsn.created_at || "") && rsn.deleted_at && !lsn.deleted_at)) {
        Object.assign(lsn, { ...rsn, id: lsn.id });
      }
    }

    // 6. Synced settings (mood_groups timezone-safe LWW)
    const tsEpoch = (s) => {
      const t = String(s || "").trim();
      if (!t) return 0;
      const ms = new Date(t).getTime();
      return Number.isFinite(ms) ? ms : 0;
    };
    const rSet = remote.settings || {};
    if (rSet.mood_groups !== undefined) {
      const rMgUpd = String(rSet.mood_groups_updated_at || "");
      const lMgUpd = String(out.settings.mood_groups_updated_at || "");
      if (tsEpoch(rMgUpd) > tsEpoch(lMgUpd) || (!lMgUpd && rSet.mood_groups)) {
        out.settings.mood_groups = String(rSet.mood_groups);
        out.settings.mood_groups_updated_at = rMgUpd || new Date().toISOString();
        if (rSet.active_mood_group !== undefined) {
          out.settings.active_mood_group = String(rSet.active_mood_group);
        }
      }
    }

    out.next_id = maxId + 1;
    return out;
  }

  async function createGistVaultFromBrowser(authToken) {
    const tok = String(authToken || "").trim();
    if (!tok) throw new Error("GitHub Gist-Token fehlt");
    const key = generateKeyB64u();
    const localDb = window.DailyLocalEngine.getRawDB();
    const envelope = await encryptPayload(
      { schema: 1, updated_at: new Date().toISOString(), ...localDb },
      key
    );
    const res = await fetch("https://api.github.com/gists", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tok}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        description: "Daily Encrypted Sync Vault (AES-256-GCM)",
        public: false,
        files: { [VAULT_FILENAME]: { content: JSON.stringify(envelope) } },
      }),
    });
    if (!res.ok) throw new Error(`GitHub Gist Fehler (HTTP ${res.status})`);
    const data = await res.json();
    const cfg = saveCfg({
      enabled: true,
      provider: "gist",
      gist_id: data.id,
      auth_token: tok,
      key_b64u: key,
      last_sync_at: new Date().toISOString(),
    });
    return { ...cfg, pair_url: buildPairingUrl(cfg) };
  }

  function formatAuthHeader(rawTok) {
    const t = String(rawTok || "").trim();
    if (!t) return "";
    if (/^(Bearer|Basic)\s+/i.test(t)) return t;
    return `Bearer ${t}`;
  }

  let _syncInFlight = null;
  let _syncQueued = false;

  async function _syncBrowserVaultOnce(opts = {}) {
    const cfg = loadCfg();
    if (!cfg.enabled || !cfg.key_b64u) return { skipped: true };
    if (!window.DailyLocalEngine) return { skipped: true };
    if (typeof navigator !== "undefined" && navigator.onLine === false) return { offline: true };

    let remoteEnvelope = null;
    if (!opts.skipPull) {
      const bust = `_=${Date.now()}`;
      if (cfg.provider === "gist") {
        if (!cfg.gist_id || !cfg.auth_token) throw new Error("Gist-ID oder Token fehlt");
        // NOTE: Do NOT set `cache: "no-store"` — Firefox/WebKit sends Cache-Control/Pragma which api.github.com rejects in CORS preflight!
        const getRes = await fetch(`https://api.github.com/gists/${encodeURIComponent(cfg.gist_id)}?${bust}`, {
          headers: {
            Authorization: `Bearer ${cfg.auth_token}`,
            Accept: "application/vnd.github+json",
          },
        });
        if (!getRes.ok) throw new Error(`Gist Abruf fehlgeschlagen (HTTP ${getRes.status})`);
        const gist = await getRes.json();
        const f = gist.files && gist.files[VAULT_FILENAME];
        if (f && f.content) remoteEnvelope = JSON.parse(f.content);
      } else if (cfg.provider === "url") {
        if (!cfg.endpoint_url) throw new Error("WebDAV / Relay URL fehlt");
        const auth = formatAuthHeader(cfg.auth_token);
        const headers = auth ? { Authorization: auth } : {};
        const sep = cfg.endpoint_url.includes("?") ? "&" : "?";
        const getRes = await fetch(`${cfg.endpoint_url}${sep}${bust}`, { headers });
        if (getRes.ok) {
          const body = await getRes.json();
          if (body && body.alg === "AES-256-GCM") remoteEnvelope = body;
        } else if (getRes.status !== 404) {
          throw new Error(`Tresor-Abruf fehlgeschlagen (HTTP ${getRes.status})`);
        }
      }
    }

    let mergedDb = window.DailyLocalEngine.getRawDB();
    if (remoteEnvelope) {
      const remoteState = await decryptPayload(remoteEnvelope, cfg.key_b64u);
      mergedDb = mergeDatabases(mergedDb, remoteState);
      window.DailyLocalEngine.setRawDB(mergedDb);
    }

    const freshEnvelope = await encryptPayload(
      { schema: 1, updated_at: new Date().toISOString(), ...mergedDb },
      cfg.key_b64u
    );

    if (cfg.provider === "gist") {
      const patchRes = await fetch(`https://api.github.com/gists/${encodeURIComponent(cfg.gist_id)}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${cfg.auth_token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ files: { [VAULT_FILENAME]: { content: JSON.stringify(freshEnvelope) } } }),
      });
      if (!patchRes.ok) throw new Error(`Gist Speichern fehlgeschlagen (HTTP ${patchRes.status})`);
    } else if (cfg.provider === "url") {
      const auth = formatAuthHeader(cfg.auth_token);
      const headers = {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: auth } : {}),
      };
      const putRes = await fetch(cfg.endpoint_url, {
        method: "PUT",
        headers,
        body: JSON.stringify(freshEnvelope),
      });
      if (!putRes.ok) throw new Error(`Tresor-Speichern fehlgeschlagen (HTTP ${putRes.status})`);
    }

    const ts = new Date().toISOString();
    saveCfg({ last_sync_at: ts });
    return { ok: true, synced_at: ts };
  }

  async function syncBrowserVault(opts = {}) {
    if (_syncInFlight) {
      _syncQueued = true;
      return _syncInFlight;
    }
    const run = (async () => {
      let res = await _syncBrowserVaultOnce(opts);
      while (_syncQueued) {
        _syncQueued = false;
        res = await _syncBrowserVaultOnce();
      }
      return res;
    })();
    _syncInFlight = run;
    try {
      return await run;
    } finally {
      _syncInFlight = null;
    }
  }

  const exported = {
    generateKeyB64u,
    encryptPayload,
    decryptPayload,
    loadCfg,
    saveCfg,
    buildPairingUrl,
    parsePairingString,
    captureHashPairing,
    mergeDatabases,
    createGistVaultFromBrowser,
    syncBrowserVault,
  };
  if (typeof window !== "undefined") window.DailyE2EE = exported;
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
})();
