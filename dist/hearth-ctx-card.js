/* hearth-ctx-card
 * Contextual card for the Portal Hub ctx slot. Shows exactly one thing —
 * the most important thing — and renders nothing when there is nothing to say.
 *
 * Priority: camera (person / doorbell) > vacuum stuck >
 *           sports (live > recent final > imminent kickoff) > laundry >
 *           vacuum maintenance > weather alert > daily saying.
 *
 * Vanilla JS, shadow DOM, zero dependencies. Live camera uses HA's own
 * <ha-camera-stream> element with an MJPEG proxy fallback, so it keeps
 * working without WAN access.
 */

class HearthCtxCard extends HTMLElement {
  static getStubConfig() {
    return { saying: "input_text.portal_daily_saying" };
  }

  setConfig(config) {
    this._cfg = Object.assign(
      {
        accent: "#FFB27A",
        alert_color: "#ff6b5e",
        camera_linger: 20,       // seconds to keep showing after occupancy clears
        doorbell_hold: 60,       // seconds to hold camera after a doorbell press
        post_minutes: 60,        // show finals for this long
        pre_minutes: 90,         // show upcoming games this far ahead
        laundry_linger: 30,      // minutes to show "finished"
        maintenance_hours: 2,    // consumable time-left threshold
        cameras: [],
        sports: [],
        photos: null,            // {base, manifest?, interval?} idle photo rotation (replaces saying)
        alert_popup: "portal",   // portal = script.show_on_portal | local = popup on the tapped browser
        demo: null,
      },
      config
    );
    this._latch = {};   // camera key -> doorbell latch expiry (ms epoch)
    this._seen = {};    // camera key -> last time occupancy was 'on' (ms epoch)
    this._sig = null;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
  }

  set hass(hass) {
    this._hass = hass;
    const cam = this.shadowRoot && this.shadowRoot.querySelector("ha-camera-stream");
    if (cam) cam.hass = hass;
    this._evaluate();
  }

  connectedCallback() {
    this._timer = setInterval(() => this._evaluate(), 5000);
  }
  disconnectedCallback() {
    clearInterval(this._timer);
    this._stopPhotos();
  }
  getCardSize() {
    return 4;
  }

  /* ---------- helpers ---------- */

  _st(id) {
    return id && this._hass && this._hass.states[id];
  }
  _val(id) {
    const s = this._st(id);
    return s ? s.state : null;
  }
  _known(v) {
    return v !== null && v !== "unknown" && v !== "unavailable" && v !== "";
  }
  _esc(t) {
    return String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  _ago(iso) {
    return Date.now() - new Date(iso).getTime();
  }
  _fmtTime(d) {
    let h = d.getHours(), m = d.getMinutes(), ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return h + ":" + String(m).padStart(2, "0") + " " + ap;
  }
  _fmtUntil(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const day = sameDay
      ? (d.getHours() >= 18 ? "tonight" : "today")
      : d.toLocaleDateString(undefined, { weekday: "long" });
    return "Until " + this._fmtTime(d) + " " + day;
  }
  _relAgo(ms) {
    const m = Math.round(ms / 60000);
    if (m < 1) return "just now";
    if (m === 1) return "1 min ago";
    return m + " min ago";
  }

  /* ---------- tier evaluation ---------- */

  _evaluate() {
    if (!this._hass || !this._cfg) return;
    const view = this._cfg.demo ? this._demoView(this._cfg.demo) : this._pick();
    const sig = view ? JSON.stringify([view.kind, view.sig]) : "empty";
    if (sig === this._sig) {
      // live tick for countdowns without full re-render signature change
      if (view && view.tick) this._render(view);
      return;
    }
    this._sig = sig;
    this._render(view);
  }

  _pick() {
    return (
      this._cameraView() ||
      this._stuckView() ||
      this._sportsView() ||
      this._laundryView() ||
      this._maintenanceView() ||
      this._weatherView() ||
      this._photoView() ||
      this._sayingView() ||
      null
    );
  }

  /* 1 — weather alerts */
  _weatherView() {
    const s = this._st(this._cfg.weather_alerts);
    if (!s || !this._known(s.state) || parseInt(s.state) < 1) return null;
    const alerts = s.attributes.Alerts || s.attributes.alerts || [];
    if (!alerts.length) return null;
    const rank = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 };
    const a = [...alerts].sort(
      (x, y) => (rank[x.Severity] ?? 9) - (rank[y.Severity] ?? 9)
    )[0];
    const severe = a.Severity === "Extreme" || a.Severity === "Severe";
    return {
      kind: "weather",
      sig: a.Event + a.Ends,
      severe,
      event: a.Event,
      sub: this._fmtUntil(a.Ends || a.Expires) || a.Severity + " alert",
      md: this._alertMd(a),
    };
  }

  /* markdown body for the tap-for-details popup (script.show_on_portal) */
  _alertMd(a) {
    const parts = [];
    if (a.Headline) parts.push("**" + a.Headline + "**");
    if (a.Description) parts.push(a.Description);
    if (a.Instruction) parts.push("### What to do\n\n" + a.Instruction);
    if (a.AreasAffected) parts.push("*Areas: " + a.AreasAffected + "*");
    return parts.join("\n\n");
  }

  /* 2 — cameras */
  _cameraView() {
    const now = Date.now();
    let show = null;
    for (const cam of this._cfg.cameras) {
      const key = cam.camera;
      // doorbell latch
      const bell = this._st(cam.doorbell);
      if (bell && bell.state === "on") {
        this._latch[key] = now + this._cfg.doorbell_hold * 1000;
      }
      // occupancy
      const occ = this._st(cam.motion);
      if (occ && occ.state === "on") this._seen[key] = now;
      const bellActive = (this._latch[key] || 0) > now;
      const occActive =
        (occ && occ.state === "on") ||
        now - (this._seen[key] || 0) < this._cfg.camera_linger * 1000;
      if (bellActive || occActive) {
        const c = {
          kind: "camera",
          sig: key + (bellActive ? ":bell" : ":occ"),
          camera: key,
          bell: bellActive,
          label: bellActive
            ? "Someone at the door"
            : "Person at the " + (cam.name || key.split(".").pop()),
        };
        // doorbell wins over plain occupancy across cameras
        if (!show || (c.bell && !show.bell)) show = c;
      }
    }
    return show;
  }

  /* 3 — vacuum stuck */
  _stuckView() {
    const v = this._cfg.vacuum;
    if (!v) return null;
    const name = v.name || "The vacuum";
    const state = this._val(v.entity);
    const err = this._val(v.error);
    const dock = this._val(v.dock_error);
    const room = this._val(v.room);
    const cleaning = state === "cleaning" || state === "returning" || state === "error";
    const errBad = this._known(err) && err !== "none";
    const dockBad = this._known(dock) && dock !== "ok";
    const thirsty = cleaning && this._val(v.water_shortage) === "on";
    if (state === "error" || errBad) {
      const why = errBad ? err.replace(/_/g, " ") : "needs attention";
      return {
        kind: "stuck",
        sig: "err" + err + room,
        title: `<b>${this._esc(name)}</b> needs a hand`,
        sub:
          (this._known(room) ? "In the " + this._esc(room) + " — " : "") +
          this._esc(why),
      };
    }
    if (thirsty) {
      return {
        kind: "stuck",
        sig: "water",
        title: `<b>${this._esc(name)}</b> is out of water`,
        sub: "Refill the water tank to keep mopping",
      };
    }
    if (dockBad) {
      return {
        kind: "stuck",
        sig: "dock" + dock,
        title: `<b>${this._esc(name)}</b>'s dock needs attention`,
        sub: this._esc(dock.replace(/_/g, " ")),
      };
    }
    return null;
  }

  /* 4 — sports */
  _sportsView() {
    const cand = [];
    for (const id of this._cfg.sports) {
      const s = this._st(id);
      if (!s || !this._known(s.state)) continue;
      const a = s.attributes;
      if (s.state === "IN") {
        cand.push({ rank: 0, order: -this._ago(s.last_changed), s, a });
      } else if (s.state === "POST" && a.date) {
        // anchor to kickoff so stale finals never resurface after an HA
        // restart resets last_changed: game (~3.5h max) + post window
        const sinceKick = Date.now() - new Date(a.date).getTime();
        const windowMs = 210 * 60000 + this._cfg.post_minutes * 60000;
        if (sinceKick > 0 && sinceKick < windowMs) {
          cand.push({ rank: 1, order: sinceKick, s, a });
        }
      } else if (s.state === "PRE" && a.date) {
        const toKick = new Date(a.date).getTime() - Date.now();
        if (toKick > 0 && toKick < this._cfg.pre_minutes * 60000) {
          cand.push({ rank: 2, order: toKick, s, a });
        }
      }
    }
    if (!cand.length) return null;
    cand.sort((x, y) => x.rank - y.rank || x.order - y.order);
    const { s, a } = cand[0];
    const round =
      a.season && isNaN(a.season) && !/final/i.test(a.season)
        ? " · " + a.season.replace(/-/g, " ")
        : "";
    const league = (a.league_name || a.league || "") + round;
    const base = {
      kind: "sports",
      mode: s.state,
      league,
      team: {
        abbr: a.team_abbr, logo: a.team_logo,
        score: a.team_score, win: a.team_winner, name: a.team_name,
        color: (a.team_colors || [])[0],
      },
      opp: {
        abbr: a.opponent_abbr, logo: a.opponent_logo,
        score: a.opponent_score, win: a.opponent_winner, name: a.opponent_name,
        color: (a.opponent_colors || [])[0],
      },
      venue: a.venue, tv: a.tv_network, clock: a.clock, quarter: a.quarter,
      date: a.date,
      sig: s.entity_id + s.state + a.team_score + a.opponent_score + a.clock,
      tick: s.state === "IN",
    };
    return base;
  }

  /* 5 — laundry */
  _laundryView() {
    const l = this._cfg.laundry;
    if (!l) return null;
    const name = l.name || "Washer";
    const machine = this._st(l.state);
    if (!machine || !this._known(machine.state)) return null;
    const job = this._val(l.job);
    const doneIso = this._val(l.completion);
    if (machine.state === "run") {
      let left = "", doneAt = "";
      if (this._known(doneIso)) {
        const d = new Date(doneIso);
        const mins = Math.max(0, Math.round((d - Date.now()) / 60000));
        left = mins > 0 ? mins + " min left" : "finishing up";
        doneAt = "done " + this._fmtTime(d);
      }
      const jobTxt = this._known(job)
        ? job.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase()
        : "";
      return {
        kind: "laundry",
        sig: "run" + (left || job),
        tick: true,
        title: `<b>${this._esc(name)}</b>` + (left ? " · " + left : " running"),
        sub: [jobTxt, doneAt].filter(Boolean).join(" · "),
        pct: this._laundryPct(machine, doneIso),
      };
    }
    // finished linger: only after a REAL end-of-cycle.
    // The machine must have left "run" at or after its projected completion time.
    // A stop BEFORE completion means cancelled / powered off, and completion_time
    // is just a stale leftover — don't render "finished" for it.
    if (this._known(doneIso)) {
      const done = new Date(doneIso).getTime();
      const stopped = new Date(machine.last_changed).getTime();
      if (stopped + 120000 < done) return null;
      const since = Date.now() - Math.max(done, stopped);
      if (since > 0 && since < this._cfg.laundry_linger * 60000) {
        return {
          kind: "laundry",
          sig: "done" + doneIso,
          title: `<b>${this._esc(name)}</b> finished`,
          sub: "Ready to unload",
          pct: 100,
        };
      }
    }
    return null;
  }
  _laundryPct(machine, doneIso) {
    if (!this._known(doneIso)) return null;
    const start = new Date(machine.last_changed).getTime();
    const end = new Date(doneIso).getTime();
    if (end <= start) return null;
    return Math.min(99, Math.max(3, Math.round(((Date.now() - start) / (end - start)) * 100)));
  }

  /* 6 — vacuum maintenance */
  _maintenanceView() {
    const v = this._cfg.vacuum;
    if (!v || !Array.isArray(v.consumables)) return null;
    const name = v.name || "The vacuum";
    let worst = null;
    for (const c of v.consumables) {
      const secs = parseFloat(this._val(c.entity));
      if (isNaN(secs)) continue;
      if (secs <= this._cfg.maintenance_hours * 3600) {
        if (!worst || secs < worst.secs) worst = { secs, name: c.name };
      }
    }
    if (!worst) return null;
    return {
      kind: "maintenance",
      sig: worst.name,
      title: `${this._esc(name)} could use a <b>new ${this._esc(worst.name)}</b>`,
      sub: "The current one has reached the end of its life",
    };
  }

  /* 6b — idle photo rotation (hearth-frame manifest) */
  _photoView() {
    const p = this._cfg.photos;
    if (!p || !p.base) return null;
    this._loadPhotoManifest();
    if (!this._photoList || !this._photoList.length) return null;
    return { kind: "photo", sig: "p" };
  }

  _loadPhotoManifest() {
    const now = Date.now();
    if (this._photoFetchAt && now - this._photoFetchAt < 3600000) return;
    this._photoFetchAt = now;
    const p = this._cfg.photos;
    const url = p.manifest || p.base.replace(/\/$/, "") + "/manifest.json";
    fetch(url + "?t=" + now)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((m) => {
        this._photoList = (m.photos || m).filter((x) => x && x.f);
        this._photoDeck = [];
        this._evaluate();
      })
      .catch(() => { this._photoFetchAt = now - 3300000; }); // retry in ~5 min
  }

  _nextPhoto() {
    if (!this._photoDeck || !this._photoDeck.length) {
      const a = this._photoList.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      this._photoDeck = a;
    }
    return this._photoDeck.pop();
  }

  // take the next portrait from the deck (for side-by-side pairing)
  _takePortrait() {
    const d = this._photoDeck || [];
    for (let i = d.length - 1; i >= 0; i--)
      if ((d[i].h || 0) > (d[i].w || 0)) return d.splice(i, 1)[0];
    return null;
  }

  _stopPhotos() {
    clearTimeout(this._photoTimer);
    this._photoTimer = null;
    this._photoGen = (this._photoGen || 0) + 1;   // orphans any running chain
  }

  _renderPhoto() {
    const root = this.shadowRoot;
    root.innerHTML = `<style>${this._css()}</style><div class="wrap"><div class="ph"></div></div>`;
    const box = root.querySelector(".ph");
    const base = this._cfg.photos.base.replace(/\/$/, "") + "/";
    const secs = Math.max(10, this._cfg.photos.interval || 60);
    const mode = this._cfg.photos.portrait || "pair";   // pair | skip | single
    const isP = (x) => (x.h || 0) > (x.w || 0);
    const fmt = (x) => {
      const d = /^(\d{4})-(\d{2})/.exec((x && x.d) || "");
      return d ? new Date(+d[1], +d[2] - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" }) : "";
    };
    const pick = () => {
      for (let n = 0; n < 50; n++) {
        const p = this._nextPhoto();
        if (!p) return null;
        if (!isP(p) || mode === "single") return [p];
        if (mode === "skip") continue;
        const q = this._takePortrait();
        return q ? [p, q] : [p];
      }
      return null;
    };
    const gen = this._photoGen;
    const alive = () => gen === this._photoGen && box.isConnected;
    const schedule = (ms) => {
      clearTimeout(this._photoTimer);
      this._photoTimer = setTimeout(() => { if (alive()) show(); }, ms);
    };
    let lastShown = 0;
    const show = () => {
      if (!alive()) return;
      // never swap sooner than the interval, whatever woke us
      const wait = lastShown + secs * 1000 - Date.now();
      if (lastShown && wait > 500) { schedule(wait); return; }
      const set = pick();
      if (!set) return;
      const imgs = set.map((p) => { const i = new Image(); i.src = base + p.f; return i; });
      let pending = imgs.length, failed = false;
      const done = () => {
        if (--pending > 0) return;
        if (!alive()) return;
        if (failed) { schedule(2000); return; }
        lastShown = Date.now();
        schedule(secs * 1000);
        const layer = document.createElement("div");
        layer.className = "layer" + (imgs.length > 1 ? " pair" : "");
        imgs.forEach((img, k) => {
          const cell = document.createElement("div");
          cell.className = "cell";
          if (imgs.length === 1 && isP(set[k])) img.className = "portrait";
          const cap = document.createElement("div");
          cap.className = "cap";
          cap.textContent = fmt(set[k]);
          cell.append(img, cap);
          layer.append(cell);
        });
        box.append(layer);
        requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add("on")));
        // drop older layers after the crossfade so only the current set stays decoded
        setTimeout(() => {
          while (box.children.length > 1) { const o = box.firstChild; o.querySelectorAll("img").forEach((i) => (i.src = "")); o.remove(); }
        }, 1600);
      };
      imgs.forEach((i) => { i.onload = done; i.onerror = () => { failed = true; done(); }; });
      schedule(secs * 1000 + 15000);   // safety net if a load never settles
    };
    show();
  }

  /* 7 — daily saying */
  _sayingView() {
    const raw = this._val(this._cfg.saying);
    if (!this._known(raw)) return null;
    const [q, by] = raw.split("|");
    if (!q || !q.trim()) return null;
    return { kind: "saying", sig: raw, quote: q.trim(), by: (by || "").trim() };
  }

  /* ---------- demo data for on-device visual testing ---------- */

  _demoView(kind) {
    const demos = {
      weather: {
        kind: "weather", sig: "d", severe: true,
        event: "Excessive Heat Warning",
        sub: "Until 8:00 PM tonight",
        md: "**EXCESSIVE HEAT WARNING IN EFFECT UNTIL 8 PM PDT**\n\n* WHAT...Dangerously hot conditions 105 to 112.\n\n* WHEN...Until 8 PM PDT this evening.\n\n### What to do\n\nDrink plenty of fluids and stay out of the sun.\n\n*Areas: Inland Empire*",
      },
      camera: this._cfg.cameras.length
        ? {
            kind: "camera", sig: "d", bell: false,
            camera: this._cfg.cameras[0].camera,
            label: "Person at the " + (this._cfg.cameras[0].name || "porch"),
          }
        : null,
      camera2: this._cfg.cameras.length > 1
        ? {
            kind: "camera", sig: "d2", bell: true,
            camera: this._cfg.cameras[1].camera,
            label: "Someone at the door",
          }
        : null,
      stuck: {
        kind: "stuck", sig: "d",
        title: "<b>Rosie</b> needs a hand",
        sub: "In the Living Room — cliff sensor error",
      },
      sports: {
        kind: "sports", sig: "d", mode: "IN",
        league: "FIFA World Cup · round of 16",
        team: { abbr: "USA", logo: "https://a.espncdn.com/i/teamlogos/countries/500/usa.png", score: "2", color: "#002868" },
        opp: { abbr: "MAR", logo: "https://a.espncdn.com/i/teamlogos/countries/500/mar.png", score: "1", color: "#df2027" },
        venue: "NRG Stadium", tv: "FOX", clock: "73'",
      },
      final: {
        kind: "sports", sig: "df", mode: "POST",
        league: "NFL",
        team: { abbr: "LAC", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/lac.png", score: "27", win: true, name: "Chargers", color: "#0080C6" },
        opp: { abbr: "DEN", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/den.png", score: "17", win: false, name: "Broncos", color: "#FB4F14" },
        venue: "SoFi Stadium",
      },
      pre: {
        kind: "sports", sig: "dp", mode: "PRE",
        league: "FIFA World Cup · round of 16",
        team: { abbr: "USA", name: "USA" }, opp: { abbr: "MAR", name: "Morocco" },
        venue: "NRG Stadium", tv: "FOX",
        date: new Date(Date.now() + 45 * 60000).toISOString(),
      },
      laundry: {
        kind: "laundry", sig: "d",
        title: "<b>Dryer</b> · 12 min left",
        sub: "normal cycle · done 2:40 PM", pct: 72,
      },
      maintenance: {
        kind: "maintenance", sig: "d",
        title: "Rosie could use a <b>new filter</b>",
        sub: "The current one has reached the end of its life",
      },
      saying: {
        kind: "saying", sig: "d",
        quote: "Cooking is like love — it should be entered into with abandon, or not at all.",
        by: "Harriet Van Horne",
      },
    };
    return demos[kind] || null;
  }

  /* ---------- rendering ---------- */

  _css() {
    const A = this._cfg.accent, R = this._cfg.alert_color;
    return `
      :host { display:block; height:100%; }
      .wrap { position:relative; height:100%; overflow:hidden;
        font-family:Roboto,sans-serif; color:rgba(255,255,255,.97);
        display:flex; flex-direction:column; justify-content:center; }
      .amber { color:${A}; }
      .hairline { height:1px; border:none; margin:22px 0 0; width:70%;
        background:linear-gradient(90deg,${A}80,rgba(255,255,255,.06)); }
      .tag { font-size:12px; letter-spacing:.22em; font-weight:600;
        text-transform:uppercase; margin-bottom:10px; }
      h1 { font-size:44px; font-weight:300; line-height:1.08; margin:0 0 8px; }
      h1 b { font-weight:500; color:${A}; }
      .sub { font-size:19px; font-weight:300; color:rgba(255,255,255,.45); }

      /* camera */
      .cam { position:absolute; inset:0; border-radius:18px; overflow:hidden;
        background:#101218; }
      .cam ha-camera-stream, .cam img.feed {
        position:absolute; top:50%; left:50%; width:100%; min-height:100%;
        transform:translate(-50%,-50%); object-fit:cover; display:block; }
      .cam .overlay { position:absolute; left:0; right:0; bottom:0; z-index:2;
        padding:36px 22px 14px; display:flex; align-items:center; gap:12px;
        background:linear-gradient(transparent,rgba(6,7,10,.85)); }
      .cam .who { font-size:22px; font-weight:400; }
      .cam .dot { width:8px; height:8px; border-radius:50%;
        background:${R}; box-shadow:0 0 8px ${R}; }

      /* sports */
      .lg { font-size:12px; letter-spacing:.22em; text-transform:uppercase;
        color:rgba(255,255,255,.35); font-weight:500;
        display:flex; gap:14px; align-items:center; }
      .lg .live { color:${A}; display:flex; gap:8px; align-items:center; }
      .lg .live::before { content:''; width:7px; height:7px; border-radius:50%;
        background:${A}; box-shadow:0 0 8px ${A}; }
      .row { display:flex; align-items:center; gap:26px; margin-top:14px; }
      .teamcol { display:flex; flex-direction:column; align-items:center; width:130px; }
      .teamcol img { width:60px; height:60px; object-fit:contain; }
      .teamcol .big { font-size:34px; font-weight:500; line-height:60px; }
      .teamcol .ab { margin-top:6px; font-size:14px; letter-spacing:.12em;
        color:rgba(255,255,255,.55); font-weight:500; }
      .score { font-size:80px; font-weight:200; line-height:1; letter-spacing:-.02em;
        display:flex; align-items:center; gap:22px; flex:1; justify-content:center; }
      .score .us { color:${A}; }
      .score .sep { font-size:38px; color:rgba(255,255,255,.25); font-weight:300; }
      .foot { margin-top:12px; font-size:16px; font-weight:300;
        color:rgba(255,255,255,.45); text-align:center; }
      .foot b { color:rgba(255,255,255,.8); font-weight:400; }

      /* laundry */
      .bar { width:70%; height:2px; background:rgba(255,255,255,.08);
        border-radius:1px; margin-top:22px; }
      .bar i { display:block; height:2px; border-radius:1px;
        background:linear-gradient(90deg,${A},${A}80); }

      /* idle photo */
      .ph { position:absolute; inset:0; border-radius:18px; overflow:hidden; background:#0b0c10; }
      .ph .layer { position:absolute; inset:0; opacity:0; transition:opacity 1.4s ease; }
      .ph .layer.on { opacity:1; }
      .ph .cell { position:absolute; inset:0; }
      .ph .pair { display:flex; gap:6px; }
      .ph .pair .cell { position:relative; flex:1; }
      .ph img { width:100%; height:100%; object-fit:cover; object-position:center 35%; display:block; }
      .ph img.portrait { object-fit:contain; }
      .ph .cap { position:absolute; left:16px; bottom:12px; font-size:13px; font-weight:600;
        letter-spacing:.18em; text-transform:uppercase; color:${A};
        text-shadow:0 1px 6px rgba(0,0,0,.8); }

      /* saying */
      .say .q { font-size:29px; font-weight:300; line-height:1.35;
        color:rgba(255,255,255,.85); padding-right:40px; }
      .say .q::before { content:'\\201C'; color:${A}; font-size:38px; font-weight:500; margin-right:2px; }
      .say .q::after { content:'\\201D'; color:${A}; font-size:38px; font-weight:500;
        margin-left:2px; line-height:0; vertical-align:-11px; }
      .say .a { margin-top:12px; font-size:16px; letter-spacing:.02em;
        color:rgba(255,255,255,.40); font-weight:400; font-style:italic; }
    `;
  }

  _render(view) {
    const root = this.shadowRoot;
    this._stopPhotos();
    if (view && view.kind === "photo") {
      this._renderPhoto();
      return;
    }
    if (!view) {
      root.innerHTML = "";
      return;
    }
    if (view.kind === "camera") {
      this._renderCamera(view);
      return;
    }
    let body = "";
    switch (view.kind) {
      case "weather": {
        const col = view.severe ? this._cfg.alert_color : this._cfg.accent;
        body = `
          <div class="tag" style="color:${col}">&#9888; ${view.severe ? "Severe Weather" : "Weather Advisory"}</div>
          <h1>${this._esc(view.event)}</h1>
          <div class="sub">${this._esc(view.sub)}${view.md ? ' <span style="color:rgba(255,255,255,.25)">&middot; tap for details</span>' : ""}</div>
          <hr class="hairline">`;
        break;
      }
      case "stuck":
      case "maintenance": {
        const soft = view.kind === "maintenance";
        body = `
          <h1 style="${soft ? "font-size:34px;" : ""}">${view.title}</h1>
          <div class="sub">${this._esc(view.sub)}</div>
          ${soft ? "" : '<hr class="hairline">'}`;
        break;
      }
      case "sports":
        body = this._sportsHtml(view);
        break;
      case "laundry":
        body = `
          <h1>${view.title}</h1>
          <div class="sub">${this._esc(view.sub)}</div>
          ${view.pct != null ? `<div class="bar"><i style="width:${view.pct}%"></i></div>` : ""}`;
        break;
      case "saying":
        body = `
          <div class="say">
            <div class="q">${this._esc(view.quote)}</div>
            ${view.by ? `<div class="a">&mdash; ${this._esc(view.by)}</div>` : ""}
          </div>`;
        break;
    }
    root.innerHTML = `<style>${this._css()}</style><div class="wrap">${body}</div>`;
    if (view.kind === "weather" && view.md) {
      const wrap = root.querySelector(".wrap");
      wrap.style.cursor = "pointer";
      wrap.addEventListener("click", () => {
        if (this._cfg.alert_popup === "local") this._localPopup(view.event, view.md);
        else
          this._hass.callService("script", "show_on_portal", {
            title: view.event,
            text: view.md,
          });
      });
    }
  }

  /* browser_mod popup on whichever browser was tapped (no registration needed) */
  _localPopup(title, md) {
    const A = this._cfg.accent;
    this.dispatchEvent(new CustomEvent("ll-custom", {
      bubbles: true, composed: true,
      detail: { browser_mod: { service: "browser_mod.popup", data: {
        title, size: "wide", dismissable: true,
        style: `--popup-background-color:#101218; --popup-border-radius:28px;
          --popup-padding-x:36px; --popup-padding-y:26px;
          --primary-text-color:rgba(255,255,255,.97); --primary-color:${A};
          --ha-dialog-surface-background:#101218; --md-dialog-container-color:#101218;
          --mdc-theme-surface:#101218; --card-background-color:#101218;
          --dialog-header-text-color:${A}; --mdc-dialog-heading-ink-color:${A};`,
        content: {
          type: "markdown", content: md,
          card_mod: { style: {
            ".": "ha-card { background:none; box-shadow:none; border:none; color:rgba(255,255,255,.85); font-size:19px; font-weight:300; line-height:1.55; }",
            "ha-markdown$": `h1,h2,h3 { color:${A}; font-weight:400; } strong { color:rgba(255,255,255,.97); font-weight:500; }`,
          } },
        },
      } } },
    }));
  }

  _teamCol(t) {
    const abbr = this._esc(t.abbr || "");
    const logo = t.logo
      ? `<img src="${this._esc(t.logo)}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'big',textContent:'${abbr}',style:'border-bottom:3px solid ${this._esc(t.color || "#666")}'}))">`
      : `<span class="big" style="border-bottom:3px solid ${this._esc(t.color || "#666")}">${abbr}</span>`;
    return `<div class="teamcol">${logo}<span class="ab">${abbr}</span></div>`;
  }

  _sportsHtml(v) {
    const A = this._cfg.accent;
    if (v.mode === "PRE") {
      const d = v.date ? new Date(v.date) : null;
      const foot = [d ? "Kickoff " + this._fmtTime(d) : "", v.venue, v.tv]
        .filter(Boolean).join(" · ");
      return `
        <div class="lg"><span>${this._esc(v.league)}</span></div>
        <h1 style="font-size:34px;margin-top:14px;"><b>${this._esc(v.team.name || v.team.abbr)}</b> vs ${this._esc(v.opp.name || v.opp.abbr)}</h1>
        <div class="sub">${this._esc(foot)}</div>
        <hr class="hairline">`;
    }
    const live = v.mode === "IN";
    const tag = live
      ? `<span class="live">Live</span><span>${this._esc(v.league)}</span>`
      : `<span style="color:${A};letter-spacing:.22em;">Final</span><span>${this._esc(v.league)}</span>`;
    let foot;
    if (live) {
      foot = [`<b>${this._esc(v.clock || "")}</b>`, this._esc(v.venue || ""), this._esc(v.tv || "")]
        .filter((x) => x && x !== "<b></b>").join(" · ");
    } else {
      const res = v.team.win
        ? (v.team.name || v.team.abbr) + " win"
        : v.opp.win
          ? (v.opp.name || v.opp.abbr) + " win"
          : "Draw";
      foot = [this._esc(res), this._esc(v.venue || "")].filter(Boolean).join(" · ");
    }
    return `
      <div class="lg">${tag}</div>
      <div class="row">
        ${this._teamCol(v.team)}
        <div class="score"><span class="us">${this._esc(v.team.score ?? "")}</span><span class="sep">&ndash;</span><span>${this._esc(v.opp.score ?? "")}</span></div>
        ${this._teamCol(v.opp)}
      </div>
      <div class="foot">${foot}</div>`;
  }

  _renderCamera(view) {
    const root = this.shadowRoot;
    const existing = root.querySelector(".cam");
    if (existing && existing.dataset.cam === view.camera) {
      const who = root.querySelector(".who");
      if (who) who.textContent = view.label;
      return;
    }
    root.innerHTML = `<style>${this._css()}</style>
      <div class="wrap"><div class="cam" data-cam="${this._esc(view.camera)}">
        <div class="overlay"><span class="dot"></span><span class="who">${this._esc(view.label)}</span></div>
      </div></div>`;
    const box = root.querySelector(".cam");
    const stateObj = this._hass.states[view.camera];
    if (!stateObj) return;
    // MJPEG proxy stream on purpose: WebRTC/HLS video layers stall or
    // mis-composite on this old Android WebView. MJPEG in an <img> is a
    // true live feed and renders like any other image.
    const img = document.createElement("img");
    img.className = "feed";
    img.src = `/api/camera_proxy_stream/${view.camera}?token=${stateObj.attributes.access_token}`;
    box.prepend(img);
  }
}

customElements.define("hearth-ctx-card", HearthCtxCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "hearth-ctx-card",
  name: "Hearth Context Card",
  description:
    "One-slot contextual display: weather alerts, cameras, vacuum, sports, laundry, daily saying.",
});
