// app.js
(function () {
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);
  const CFG = window.HEATMAP_CONFIG || {};
  const state = {
    lookup: new Map(), latLngCache: new Map(),
    datasets: [], active: null, layers: [],
    points: [], pointByPin: new Map(), hits: [], pinnedPin: null,
    map: null, ov: null, canvas: null, cursor: false,
    layersTouched: false, activeTouched: false, needFit: false,
    pivotSheet: null, pivotCol: null, filterSheetId: null,
    mapOk: false, lookupOk: false,
    stampCanvas: null, stampRadius: 0
  };
  const nf = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
  const nf1 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 });
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dsById = id => state.datasets.find(d => d.id === id) || null;
  const dsOf = L => dsById(L.ds);
  const multi = () => state.datasets.length > 1;

  // Tab switching
  $$('.tab-btn').forEach(btn => {
    btn.onclick = () => {
      $$('.tab-btn').forEach(b => b.classList.remove('active'));
      $$('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $('#' + btn.dataset.tab).classList.add('active');
    };
  });

  // Setup status pill toggle
  $('#statusPill').onclick = () => $('#setupDrawer').classList.toggle('open');
  function updateSetupPill() {
    const pill = $('#statusPill'), drawer = $('#setupDrawer');
    if (state.mapOk && state.lookupOk) {
      pill.textContent = '● Ready (' + state.lookup.size.toLocaleString() + ' pins)';
      pill.className = 'ok';
      drawer.classList.remove('open');
    } else {
      pill.textContent = '⚠ Setup Required';
      pill.className = 'err';
    }
  }

  function buildRamp(name, stops) {
    const lut = new Uint8ClampedArray(1024);
    for (let i = 0; i < 256; i++) {
      const t = i / 255; let k = 0;
      while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
      const a = stops[k], b = stops[k + 1], span = b[0] - a[0];
      const f = span > 0 ? clamp((t - a[0]) / span, 0, 1) : 0;
      for (let c = 0; c < 3; c++) lut[i * 4 + c] = Math.round(a[1][c] + (b[1][c] - a[1][c]) * f);
      lut[i * 4 + 3] = Math.round(255 * (a[1][3] + (b[1][3] - a[1][3]) * f));
    }
    return {
      name, stops, lut,
      css: 'linear-gradient(90deg,' + stops.map(s => 'rgb(' + s[1].slice(0, 3).join(',') + ') ' + Math.round(s[0] * 100) + '%').join(',') + ')',
      accent: stops[stops.length - 1][1].slice(0, 3)
    };
  }

  function fromColours(name, cols) {
    const n = cols.length, stops = [[0, cols[0].concat(0)], [0.15, cols[0].concat(0.8)]];
    for (let i = 1; i < n; i++) stops.push([0.35 + 0.65 * (i - 1) / (n - 2), cols[i].concat(1)]);
    return buildRamp(name, stops);
  }

  const RAMPS = {
    orig:    buildRamp('Classic (Blue → Green → Yellow → Red)', [[0, [43,131,186,0]], [.15, [43,131,186,.8]], [.35, [171,221,164,1]], [.55, [255,255,191,1]], [.78, [253,174,97,1]], [1, [215,25,28,1]]]),
    warm:    buildRamp('Neon Gold → Crimson', [[0, [255,214,0,0]], [.15, [255,214,0,.85]], [.5, [255,122,0,1]], [1, [210,0,40,1]]]),
    cool:    buildRamp('Cyan → Electric Blue', [[0, [0,214,255,0]], [.15, [0,214,255,.85]], [.5, [31,120,224,1]], [1, [27,20,100,1]]]),
    purples: fromColours('Purples', [[158,154,200], [117,107,177], [84,39,143], [63,0,125]]),
    greens:  fromColours('Emeralds', [[116,196,118], [49,163,84], [0,109,44], [0,68,27]]),
    magma:   fromColours('Magma', [[254,176,120], [241,96,93], [183,55,121], [114,31,129], [44,17,95]]),
    reds:    fromColours('Reds', [[252,174,145], [251,106,74], [222,45,38], [165,15,21]])
  };
  const NEXT_RAMPS = ['warm', 'cool', 'orig', 'purples', 'greens', 'magma', 'reds'];
  const SHAPES = ['circle', 'square', 'diamond', 'triangle'];
  const SHAPE_ICON = { circle: '●', square: '■', diamond: '◆', triangle: '▲' };

  function norm(q, scl, mx) {
    if (!(mx > 0)) return 0;
    if (scl === 'sqrt') return Math.sqrt(q / mx);
    if (scl === 'log') return Math.log(1 + q) / Math.log(1 + mx);
    return q / mx;
  }

  function unnorm(t, scl, mx) {
    if (scl === 'sqrt') return t * t * mx;
    if (scl === 'log') return Math.exp(t * Math.log(1 + mx)) - 1;
    return t * mx;
  }

  const STYLES = {
    gray: [{ featureType: 'poi', stylers: [{ visibility: 'off' }] }, { stylers: [{ saturation: -85 }, { lightness: 20 }] }],
    dark: [
      { elementType: 'geometry', stylers: [{ color: '#1d2026' }] },
      { elementType: 'labels.text.fill', stylers: [{ color: '#8c939e' }] },
      { elementType: 'labels.text.stroke', stylers: [{ color: '#161920' }] },
      { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0d1117' }] },
      { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2b303c' }] },
      { featureType: 'poi', stylers: [{ visibility: 'off' }] },
      { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#454c59' }] }
    ]
  };

  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const nextFrame = f => window.requestAnimationFrame ? window.requestAnimationFrame(f) : setTimeout(f, 16);
  const setStatus = (sel, msg, kind) => {
    const e = $(sel);
    if (!e) return;
    e.textContent = (kind === 'ok' ? '✓ ' : kind === 'err' ? '✗ ' : '') + msg;
    e.className = 'note ' + (kind || '');
  };
  const keyOf = v => (v == null || v === '') ? '(blank)' : String(v);
  const pad = n => String(n).padStart(2, '0');
  const fmtDate = ms => { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const sod = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const eod = ms => sod(ms) + 86399999;
  const show = v => v instanceof Date ? fmtDate(v.getTime()) : String(v);
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const mkSelect = (opts, value, onchange) => {
    const s = mk('select');
    opts.forEach(([v, l]) => { const o = mk('option', '', l); o.value = v; s.append(o); });
    s.value = value; s.onchange = () => onchange(s.value); return s;
  };
  const mkField = (label, control) => { const f = mk('div', 'field'); f.append(mk('span', '', label)); f.append(control); return f; };

  function normPin(v) {
    if (v == null) return null;
    let s = String(v).trim();
    if (/^\d+\.0+$/.test(s)) s = s.split('.')[0];
    s = s.replace(/\D/g, '');
    if (!s) return null;
    if (s.length < 6) s = s.padStart(6, '0');
    return s.length === 6 ? s : null;
  }

  function tableFromSheet(ws) {
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
    if (!aoa.length) return [];
    const look = Math.min(aoa.length, 15);
    const filled = r => (r || []).filter(v => v != null && v !== '').length;
    const cnt = aoa.slice(0, look).map(filled);
    const maxc = Math.max.apply(null, cnt);
    if (maxc === 0) return [];
    let h = 0;
    const cand = cnt.findIndex(c => c >= Math.max(2, 0.6 * maxc));
    if (cand > 0) {
      const strs = aoa[cand].filter(v => typeof v === 'string' && v.trim() !== '').length;
      if (strs >= 0.6 * cnt[cand]) h = cand;
    }
    const head = (aoa[h] || []).map((v, i) => (v == null || v === '') ? 'Column ' + (i + 1) : String(v).trim());
    const seen = {};
    head.forEach((n, i) => { if (seen[n]) { seen[n]++; head[i] = n + '_' + seen[n]; } else seen[n] = 1; });
    const rows = [];
    for (let i = h + 1; i < aoa.length; i++) {
      const r = aoa[i];
      if (!r || !r.some(v => v != null && v !== '')) continue;
      const o = {};
      head.forEach((n, j) => { o[n] = r[j] === undefined ? null : r[j]; });
      rows.push(o);
    }
    return rows;
  }

  function sheetsFromBuffer(buf) {
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true });
    return wb.SheetNames.map(n => ({ name: n, rows: tableFromSheet(wb.Sheets[n]) })).filter(s => s.rows.length);
  }
  function readBuffer(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = e => res(e.target.result);
      r.onerror = () => rej(r.error);
      r.readAsArrayBuffer(file);
    });
  }
  async function fetchBuffer(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.arrayBuffer();
  }
  const firstSheetRows = buf => { const s = sheetsFromBuffer(buf); return s.length ? s[0].rows : []; };

  function loadMapsScript(key) {
    return new Promise((res, rej) => {
      if (window.google && google.maps && google.maps.Map) return res();
      window.gm_authFailure = () => {
        state.mapOk = false; updateSetupPill();
        setStatus('#mapStatus', 'Google rejected the API key.', 'err');
        $('#setupDrawer').classList.add('open');
      };
      const s = document.createElement('script');
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&v=weekly';
      s.async = true;
      s.onload = () => res();
      s.onerror = () => rej(new Error('Could not reach Google Maps.'));
      document.head.appendChild(s);
    });
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    nextFrame(() => { renderQueued = false; render(); });
  }

  async function startMap() {
    const key = $('#key').value.trim();
    if (!key) { state.mapOk = false; updateSetupPill(); return setStatus('#mapStatus', 'No API key.', 'err'); }
    setStatus('#mapStatus', 'Loading map…');
    try { await loadMapsScript(key); } catch (e) { state.mapOk = false; updateSetupPill(); return setStatus('#mapStatus', e.message, 'err'); }
    if (!state.map) {
      const mapDiv = $('#map');
      state.map = new google.maps.Map(mapDiv, {
        center: { lat: 19.076, lng: 72.8777 }, zoom: 10, minZoom: 3,
        streetViewControl: false, mapTypeControl: false, fullscreenControl: true, clickableIcons: false
      });
      const ov = new google.maps.OverlayView();
      ov.onAdd = function () {}; ov.onRemove = function () {}; ov.draw = scheduleRender;
      ov.setMap(state.map); state.ov = ov;

      const cv = document.createElement('canvas');
      Object.assign(cv.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none', zIndex: '1' });
      mapDiv.appendChild(cv); state.canvas = cv;

      ['bounds_changed', 'zoom_changed', 'idle'].forEach(e => state.map.addListener(e, scheduleRender));
      state.map.addListener('click', onMapClick);
      mapDiv.addEventListener('mousemove', onMouseMove);

      applyBasemap();
    }
    state.mapOk = true;
    setStatus('#mapStatus', 'Map ready.', 'ok');
    updateSetupPill();
    if (state.needFit && state.points.length) { state.needFit = false; fitToData(); }
    render();
  }

  function applyBasemap() {
    if (!state.map) return;
    const v = $('#basemap').value;
    state.map.setOptions({ mapTypeId: (v === 'gray' || v === 'dark') ? 'roadmap' : v, styles: STYLES[v] || null });
    render();
  }

  function buildLookup(rows) {
    const cols = Object.keys(rows[0] || {});
    const pc = cols.find(c => /pin|postal|zip/i.test(c));
    const la = cols.find(c => /^lat/i.test(c));
    const lo = cols.find(c => /^(lon|lng|long)/i.test(c));
    if (!pc || !la || !lo) throw new Error('Missing Pincode / Latitude / Longitude columns.');
    const acc = new Map();
    for (const r of rows) {
      const p = normPin(r[pc]); const a = parseFloat(r[la]); const b = parseFloat(r[lo]);
      if (!p || !isFinite(a) || !isFinite(b)) continue;
      if (a < 6 || a > 38 || b < 67 || b > 98) continue;
      const o = acc.get(p) || { a: 0, b: 0, n: 0 };
      o.a += a; o.b += b; o.n++; acc.set(p, o);
    }
    const m = new Map();
    state.latLngCache.clear();
    acc.forEach((o, p) => { m.set(p, [o.a / o.n, o.b / o.n]); });
    if (!m.size) throw new Error('No valid India pincodes found.');
    return m;
  }

  function lookupReady() {
    state.lookupOk = true;
    setStatus('#lookupStatus', state.lookup.size.toLocaleString() + ' pincodes loaded.', 'ok');
    updateSetupPill();
    reguessAll();
    refreshData();
  }

  function guessPinCol(cols, rows) {
    const hasLk = state.lookup.size > 0;
    let best = null, bs = -1;
    for (const c of cols) {
      let valid = 0, hit = 0, t = 0;
      for (let i = 0; i < Math.min(rows.length, 500); i++) {
        const v = rows[i][c]; if (v == null || v === '') continue;
        t++;
        const p = normPin(v);
        if (p) { valid++; if (hasLk && state.lookup.has(p)) hit++; }
      }
      let s = t ? (hasLk ? 2 * hit / t + 0.5 * valid / t : valid / t) : 0;
      if (/pin|postal|zip/i.test(c)) s += 0.75;
      if (s > bs) { bs = s; best = c; }
    }
    return best;
  }

  function profile(d, col) {
    let n = 0, nn = 0, nd = 0, mn = Infinity, mx = -Infinity, dmn = Infinity, dmx = -Infinity, capped = false;
    const u = new Set();
    for (const r of d.rows) {
      const v = r[col];
      if (v == null || v === '') continue;
      n++;
      if (typeof v === 'number' && isFinite(v)) { nn++; if (v < mn) mn = v; if (v > mx) mx = v; }
      else if (v instanceof Date && !isNaN(v)) { nd++; const t = v.getTime(); if (t < dmn) dmn = t; if (t > dmx) dmx = t; }
      if (!capped) { u.add(String(v)); if (u.size > 300) capped = true; }
    }
    if (!n) return null;
    const numeric = nn / n >= 0.9;
    const mkCat = () => {
      if (n < d.rows.length) u.add('(blank)');
      return { type: 'cat', numeric, all: [...u].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) };
    };
    if (numeric) return (!capped && u.size <= 12) ? mkCat() : { type: 'num', numeric, min: mn, max: mx };
    if (nd / n >= 0.9) return { type: 'date', numeric: false, min: dmn, max: dmx };
    if (capped) return { type: 'text', numeric: false };
    return mkCat();
  }

  function analyze(d) {
    d.filters = {}; d.numCols = []; d.colType = {};
    for (const col of d.cols) {
      if (col === d.pinCol) continue;
      const info = profile(d, col); if (!info) continue;
      if (info.numeric) d.numCols.push(col);
      d.colType[col] = info.numeric ? 'num' : (info.type === 'date' ? 'date' : 'cat');
      let f;
      if (info.type === 'cat') f = { type: 'cat', all: info.all, sel: new Set(info.all) };
      else if (info.type === 'num') f = { type: 'num', min: info.min, max: info.max, lo: info.min, hi: info.max };
      else if (info.type === 'date') { f = { type: 'date', lo: sod(info.min), hi: eod(info.max), dmin: info.min, dmax: info.max }; f.lo0 = f.lo; f.hi0 = f.hi; }
      else f = { type: 'text', q: '' };
      f.tag = { cat: 'list', num: 'range', date: 'dates', text: 'text' }[info.type];
      d.filters[col] = f;
    }
  }

  function isActive(f) {
    if (f.type === 'cat') return f.sel.size < f.all.length;
    if (f.type === 'num') return f.lo > f.min || f.hi < f.max;
    if (f.type === 'date') return f.lo !== f.lo0 || f.hi !== f.hi0;
    if (f.type === 'text') return f.q !== '';
    return false;
  }

  function updateFilterBadge() {
    let cnt = 0;
    state.datasets.forEach(d => {
      Object.values(d.filters).forEach(f => { if (isActive(f)) cnt++; });
    });
    const b = $('#filterBadge');
    b.textContent = cnt;
    b.classList.toggle('on', cnt > 0);
  }

  function buildCat(f, body) {
    body.innerHTML = '<input type="search" class="q" placeholder="Filter values…"><div class="btns"><button type="button" data-a="all">Select All</button><button type="button" data-a="none">Clear</button><span class="cnt"></span></div><div class="list"></div>';
    const list = body.querySelector('.list'), q = body.querySelector('.q'), cnt = body.querySelector('.cnt');
    const items = f.all.map(v => {
      const lab = document.createElement('label'), cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = f.sel.has(v); cb.value = v;
      lab.append(cb, document.createTextNode(v)); list.append(lab);
      return { lab, cb, v };
    });
    const upd = () => { cnt.textContent = f.sel.size + ' / ' + f.all.length; };
    list.addEventListener('change', e => {
      if (e.target.type !== 'checkbox') return;
      e.target.checked ? f.sel.add(e.target.value) : f.sel.delete(e.target.value);
      upd(); refreshData();
    });
    q.addEventListener('input', () => {
      const s = q.value.toLowerCase();
      items.forEach(it => { it.lab.style.display = it.v.toLowerCase().includes(s) ? '' : 'none'; });
    });
    body.querySelectorAll('button').forEach(b => b.onclick = () => {
      const on = b.dataset.a === 'all';
      items.forEach(it => { if (it.lab.style.display === 'none') return; it.cb.checked = on; on ? f.sel.add(it.v) : f.sel.delete(it.v); });
      upd(); refreshData();
    });
    upd();
  }

  function buildSlicerUI(d) {
    if (d.slicerEl) d.slicerEl.remove();
    const wrap = mk('div'); d.slicerEl = wrap;
    const cols = Object.keys(d.filters);
    if (!cols.length) wrap.append(mk('p', 'note', 'No filterable columns found on this sheet.'));
    for (const col of cols) {
      const f = d.filters[col];
      const det = mk('details', 'sl');
      const sum = mk('summary');
      sum.append(mk('span', '', col), mk('small', '', f.tag));
      const body = mk('div', 'body');
      det.append(sum, body);
      if (f.type === 'cat') {
        buildCat(f, body);
      } else if (f.type === 'num') {
        body.innerHTML = '<div class="range"><input type="number" step="any" class="a"><span>to</span><input type="number" step="any" class="b"></div>';
        const a = body.querySelector('.a'), b = body.querySelector('.b');
        a.value = f.lo; b.value = f.hi;
        a.oninput = () => { const v = parseFloat(a.value); f.lo = isNaN(v) ? f.min : v; refreshData(); };
        b.oninput = () => { const v = parseFloat(b.value); f.hi = isNaN(v) ? f.max : v; refreshData(); };
      } else if (f.type === 'date') {
        body.innerHTML = '<div class="range"><input type="date" class="a"><span>to</span><input type="date" class="b"></div>';
        const a = body.querySelector('.a'), b = body.querySelector('.b');
        a.value = fmtDate(f.dmin); b.value = fmtDate(f.dmax);
        a.oninput = () => { f.lo = a.value ? new Date(a.value + 'T00:00:00').getTime() : f.lo0; refreshData(); };
        b.oninput = () => { f.hi = b.value ? new Date(b.value + 'T23:59:59').getTime() : f.hi0; refreshData(); };
      } else {
        body.innerHTML = '<input type="search" placeholder="Contains text…">';
        body.querySelector('input').oninput = e => { f.q = e.target.value.trim().toLowerCase(); refreshData(); };
      }
      f.el = det; det.classList.toggle('on', isActive(f));
      wrap.append(det);
    }
    $('#slicers').innerHTML = '';
    $('#slicers').append(wrap);
  }

  function showSlicers() {
    state.datasets.forEach(d => { if (d.slicerEl) d.slicerEl.style.display = 'none'; });
    const fId = state.filterSheetId || (state.active ? state.active.id : null);
    const d = dsById(fId) || state.active;
    if (d) {
      if (!d.slicerEl) buildSlicerUI(d);
      else { $('#slicers').innerHTML = ''; $('#slicers').append(d.slicerEl); d.slicerEl.style.display = ''; }
    }
    $('#resetSlicers').style.display = d ? '' : 'none';
    updateFilterBadge();
  }

  function setPinCol(d, col) {
    d.pinCol = col;
    d.pins = d.rows.map(r => normPin(r[col]));
    d.matched = state.lookup.size ? d.pins.reduce((a, p) => a + (p && state.lookup.has(p) ? 1 : 0), 0) : null;
  }

  function autoLayers() {
    const good = state.datasets.filter(d => d.matched == null || d.matched > 0);
    const pick = (good.length ? good : state.datasets).slice(0, 2);
    state.layers = [];
    const ramps = pick.length === 1 ? ['warm'] : ['warm', 'cool'];
    pick.forEach((d, i) => state.layers.push(newLayer({ ds: d.id, ramp: ramps[i] })));
    state.layersTouched = false;
  }

  function reguessAll() {
    if (!state.datasets.length) return;
    state.datasets.forEach(d => {
      if (!d.pinManual) {
        const g = guessPinCol(d.cols, d.rows);
        if (g !== d.pinCol) { setPinCol(d, g); analyze(d); if (d.slicerEl) { d.slicerEl.remove(); d.slicerEl = null; } return; }
      }
      setPinCol(d, d.pinCol);
    });
    const good = state.datasets.find(d => d.matched > 0);
    if (!state.activeTouched && good) state.active = good;
    if (!state.filterSheetId && state.active) state.filterSheetId = state.active.id;
    if (!state.layersTouched) autoLayers();
    syncDataControls(); showSlicers(); renderLayerUI(); renderInfoUI();
  }

  function syncDataControls() {
    const hasData = state.datasets.length > 0;
    $('#sheetConfig').style.display = hasData ? 'block' : 'none';
    $('#popupSection').style.display = hasData ? 'block' : 'none';
    $('#sheetRow').style.display = multi() ? 'block' : 'none';

    const ss = $('#sheetSel'); ss.innerHTML = '';
    state.datasets.forEach(d => { const o = mk('option', '', d.name + ' (' + d.rows.length.toLocaleString() + ' rows)'); o.value = d.id; ss.append(o); });
    if (state.active) ss.value = state.active.id;

    const ps = $('#pinCol'); ps.innerHTML = '';
    if (state.active) {
      state.active.cols.forEach(c => { const o = mk('option', '', c); o.value = c; ps.append(o); });
      ps.value = state.active.pinCol;
    }

    const filterSheetRow = $('#filterSheetRow');
    filterSheetRow.style.display = multi() ? 'block' : 'none';
    const filtS = $('#filterSheetSel');
    filtS.innerHTML = '';
    state.datasets.forEach(d => { const o = mk('option', '', d.name); o.value = d.id; filtS.append(o); });
    if (!state.filterSheetId && state.active) state.filterSheetId = state.active.id;
    if (state.filterSheetId) filtS.value = state.filterSheetId;

    showSlicers();
  }

  function ingestSheets(sheets) {
    const ds = sheets.filter(s => s.rows.length).map((s, i) => {
      const d = {
        id: i + 1, name: s.name, rows: s.rows, cols: Object.keys(s.rows[0]),
        pins: [], pinCol: null, filters: {}, numCols: [], colType: {},
        groups: new Map(), unm: new Map(), kept: 0, noPin: 0, slicerEl: null, infoFields: []
      };
      d.pinCol = guessPinCol(d.cols, d.rows); setPinCol(d, d.pinCol); analyze(d);
      return d;
    });
    if (!ds.length) throw new Error('No sheet with rows found.');
    state.datasets = ds; state.activeTouched = false;
    state.active = ds.find(d => d.matched > 0) || ds[0];
    state.filterSheetId = state.active.id;

    state.pivotSheet = ds[0].id;
    state.pivotCol = null;
    for (const d of ds) {
      const pColMatch = d.cols.find(c => /primary|store|dealer|shop|name/i.test(c));
      if (pColMatch) { state.pivotSheet = d.id; state.pivotCol = pColMatch; break; }
    }
    if (!state.pivotCol && ds[0].cols.length) state.pivotCol = ds[0].cols[0];

    autoLayers(); state.needFit = true;
    syncDataControls(); showSlicers(); renderLayerUI(); renderInfoUI();
    const total = ds.reduce((a, d) => a + d.rows.length, 0);
    setStatus('#dataStatus', total.toLocaleString() + ' rows loaded across ' + ds.length + ' sheet(s).', 'ok');
    refreshData();
  }

  async function loadData(file) {
    setStatus('#dataStatus', 'Reading ' + file.name + '…');
    try { ingestSheets(sheetsFromBuffer(await readBuffer(file))); }
    catch (e) { setStatus('#dataStatus', 'Could not read file: ' + e.message, 'err'); }
  }

  let layerSeq = 0;
  function newLayer(over) {
    const usedR = state.layers.map(l => l.ramp), usedS = state.layers.map(l => l.shape);
    const ramp = NEXT_RAMPS.find(p => !usedR.includes(p)) || 'warm';
    const shape = SHAPES.find(s => !usedS.includes(s)) || 'circle';
    const ds = state.datasets.length ? state.datasets[state.layers.length % state.datasets.length].id : null;
    return Object.assign({
      id: ++layerSeq, ds, measure: '__count', agg: 'sum', ramp, shape,
      heat: true, dots: 'ring', scale: 'linear', ovl: 'max', visible: true,
      pts: [], min: 0, max: 0, _offCanvas: null
    }, over);
  }

  const AGG_NAMES = { sum: 'Total of ', avg: 'Average of ', max: 'Highest ' };
  function labelOf(L) {
    const d = dsOf(L);
    const base = L.measure === '__count' ? 'Row count' : AGG_NAMES[L.agg] + L.measure;
    return (d && multi() ? d.name + ' · ' : '') + base;
  }

  function layerCalc(L, idx) {
    if (L.measure === '__count') return idx.length;
    const d = dsOf(L); if (!d) return 0;
    let sum = 0, vn = 0, mx = -Infinity;
    for (let k = 0; k < idx.length; k++) {
      const v = d.rows[idx[k]][L.measure];
      if (typeof v === 'number' && isFinite(v)) { sum += v; vn++; if (v > mx) mx = v; }
    }
    if (L.agg === 'sum') return sum;
    if (L.agg === 'avg') return vn ? sum / vn : 0;
    return vn ? mx : 0;
  }

  function renderLayerUI() {
    const host = $('#layers'); host.innerHTML = '';
    state.layers.forEach(L => {
      let d = dsOf(L);
      if (!d && state.datasets.length) { d = state.datasets[0]; L.ds = d.id; }

      const measures = [['__count', 'Row count (Frequency)']];
      if (d) d.cols.forEach(c => measures.push([c, c]));
      if (L.measure !== '__count' && (!d || !d.cols.includes(L.measure))) L.measure = '__count';

      const card = mk('div', 'lcard');
      const head = mk('div', 'lhead');
      const vis = mk('input'); vis.type = 'checkbox'; vis.checked = L.visible; vis.title = 'Toggle layer visibility';
      vis.onchange = () => { L.visible = vis.checked; restyle(); };
      const title = mk('b', '', labelOf(L));
      const pos = state.layers.indexOf(L);
      const up = mk('button', '', '↑'); up.disabled = pos === 0;
      up.onclick = () => { state.layersTouched = true; state.layers.splice(pos, 1); state.layers.splice(pos - 1, 0, L); renderLayerUI(); restyle(); };
      const dn = mk('button', '', '↓'); dn.disabled = pos === state.layers.length - 1;
      dn.onclick = () => { state.layersTouched = true; state.layers.splice(pos, 1); state.layers.splice(pos + 1, 0, L); renderLayerUI(); restyle(); };
      const rm = mk('button', '', '×'); rm.disabled = state.layers.length <= 1;
      rm.onclick = () => { state.layersTouched = true; state.layers = state.layers.filter(x => x !== L); renderLayerUI(); restyle(); };
      head.append(vis, title);
      if (state.layers.length > 1) head.append(up, dn);
      head.append(rm);
      card.append(head);

      const note = mk('p', 'help err'); note.style.display = 'none'; L.noteEl = note; card.append(note);

      if (multi()) {
        const sh = mkSelect(state.datasets.map(x => [x.id, x.name]), L.ds, v => {
          state.layersTouched = true; L.ds = +v; L.measure = '__count'; renderLayerUI(); refreshData();
        });
        card.append(mkField('Sheet', sh));
      }

      const sa = mkSelect([['sum', 'Sum'], ['avg', 'Average'], ['max', 'Max']], L.agg, v => { L.agg = v; title.textContent = labelOf(L); refreshData(); });
      sa.disabled = L.measure === '__count';
      const sm = mkSelect(measures, L.measure, v => { state.layersTouched = true; L.measure = v; sa.disabled = v === '__count'; title.textContent = labelOf(L); refreshData(); });
      const two = mk('div', 'two');
      two.append(mkField('Metric', sm), mkField('Aggregation', sa));
      card.append(two);

      const swatch = mk('div', 'swatch'); swatch.style.background = RAMPS[L.ramp].css;
      const sp = mkSelect(Object.entries(RAMPS).map(([k, r]) => [k, r.name]), L.ramp, v => { L.ramp = v; swatch.style.background = RAMPS[v].css; restyle(); });
      const colorField = mkField('Color Palette', sp); colorField.append(swatch);
      card.append(colorField);

      const pills = mk('div', 'pills');
      const heatLbl = mk('label', 'pill-toggle');
      const heatCb = mk('input'); heatCb.type = 'checkbox'; heatCb.checked = L.heat !== false;
      heatCb.onchange = () => { L.heat = heatCb.checked; restyle(); };
      heatLbl.append(heatCb, document.createTextNode('Heatmap Glow'));

      const dotLbl = mk('label', 'pill-toggle');
      const dotCb = mk('input'); dotCb.type = 'checkbox'; dotCb.checked = L.dots !== 'off';
      dotCb.onchange = () => { L.dots = dotCb.checked ? 'ring' : 'off'; restyle(); };
      dotLbl.append(dotCb, document.createTextNode('Pincode Dots'));
      pills.append(heatLbl, dotLbl);
      card.append(pills);

      const adv = mk('details', 'plain');
      adv.append(mk('summary', '', 'Advanced layer options'));
      const ss = mkSelect([['linear', 'Linear'], ['sqrt', 'Square root'], ['log', 'Logarithmic']], L.scale, v => { L.scale = v; restyle(); });
      const so = mkSelect([['max', 'Independent (Max)'], ['sum', 'Additive (Stacked)']], L.ovl, v => { L.ovl = v; restyle(); });
      const advTwo1 = mk('div', 'two');
      advTwo1.append(mkField('Scale', ss), mkField('Overlap Mode', so));

      const sd = mkSelect([['ring', 'Proportional Ring'], ['fill', 'Solid Dot'], ['off', 'Hidden']], L.dots, v => { L.dots = v; dotCb.checked = (v !== 'off'); restyle(); });
      const shapeSel = mkSelect(SHAPES.map(s => [s, SHAPE_ICON[s] + ' ' + s]), L.shape, v => { L.shape = v; restyle(); });
      const advTwo2 = mk('div', 'two');
      advTwo2.append(mkField('Dot Style', sd), mkField('Dot Shape', shapeSel));
      adv.append(advTwo1, advTwo2);
      card.append(adv);

      host.append(card);
    });
  }

  const AGG_OPTS = {
    num:  [['sum', 'Total'], ['avg', 'Average'], ['min', 'Lowest'], ['max', 'Highest'], ['count', 'Count'], ['distinct', 'Distinct'], ['top', 'Most common']],
    date: [['latest', 'Latest'], ['earliest', 'Earliest'], ['count', 'Count']],
    cat:  [['top', 'Most common'], ['list', 'List values'], ['distinct', 'Distinct'], ['count', 'Count']]
  };
  const aggLabel = (f, d) => (AGG_OPTS[(d && d.colType[f.col]) || 'cat'].find(a => a[0] === f.agg) || [0, f.agg])[1];
  const defaultAgg = (d, col) => ({ num: 'sum', date: 'latest', cat: 'top' }[d.colType[col] || 'cat']);

  function renderInfoUI() {
    const host = $('#infoFields'); host.innerHTML = '';
    const d = state.active;
    if (!d) return;
    d.infoFields = d.infoFields.filter(f => d.colType[f.col]);
    d.infoFields.forEach((f, i) => {
      const row = mk('div', 'frow');
      const sc = mkSelect(d.cols.map(c => [c, c]), f.col, v => { f.col = v; f.agg = defaultAgg(d, v); renderInfoUI(); refreshCard(); });
      const sa = mkSelect(AGG_OPTS[d.colType[f.col] || 'cat'], f.agg, v => { f.agg = v; refreshCard(); });
      const x = mk('button', '', '×'); x.title = 'Remove field';
      x.onclick = () => { d.infoFields.splice(i, 1); renderInfoUI(); refreshCard(); };
      row.append(sc, sa, x);
      host.append(row);
    });
  }

  function fieldValue(f, idx, d) {
    const vals = [];
    for (let k = 0; k < idx.length; k++) {
      const v = d.rows[idx[k]][f.col];
      if (v != null && v !== '') vals.push(v);
    }
    if (!vals.length) return '—';
    const nums = () => vals.filter(v => typeof v === 'number' && isFinite(v));
    const aggType = f.agg || 'top';

    switch (aggType) {
      case 'sum': { const n = nums(); return n.length ? nf.format(n.reduce((a, b) => a + b, 0)) : '—'; }
      case 'avg': { const n = nums(); return n.length ? nf.format(n.reduce((a, b) => a + b, 0) / n.length) : '—'; }
      case 'min': { const n = nums(); return n.length ? nf.format(Math.min.apply(null, n)) : '—'; }
      case 'max': { const n = nums(); return n.length ? nf.format(Math.max.apply(null, n)) : '—'; }
      case 'count': return nf.format(vals.length);
      case 'distinct': return nf.format(new Set(vals.map(show)).size);
      case 'earliest': case 'latest': {
        const t = vals.filter(v => v instanceof Date).map(v => v.getTime());
        if (!t.length) return '—';
        return fmtDate(aggType === 'earliest' ? Math.min.apply(null, t) : Math.max.apply(null, t));
      }
      case 'list': {
        const u = [...new Set(vals.map(show))];
        return u.slice(0, 6).join(', ') + (u.length > 6 ? ' … (+' + (u.length - 6) + ' more)' : '');
      }
      default: {
        const c = new Map();
        vals.forEach(v => { const k = show(v); c.set(k, (c.get(k) || 0) + 1); });
        let bk = '', bc = 0; c.forEach((n, k) => { if (n > bc) { bc = n; bk = k; } });
        return c.size === 1 ? bk : bk + ' (' + bc + ' of ' + vals.length + ')';
      }
    }
  }

  function describe(o) {
    const lines = ['Pincode ' + o.pin];

    const pSheetId = state.pivotSheet, pCol = state.pivotCol;
    if (pSheetId && pCol) {
      const pd = dsById(pSheetId), pg = pd && o.per[pSheetId];
      if (pg) {
        const pivotGroups = new Map();
        pg.idx.forEach(i => {
          const pVal = pd.rows[i][pCol];
          const key = (pVal != null && pVal !== '') ? String(pVal).trim() : '(blank)';
          if (!pivotGroups.has(key)) pivotGroups.set(key, []);
          pivotGroups.get(key).push(i);
        });
        pivotGroups.forEach((indices, pKey) => {
          const block = mk('div');
          Object.assign(block.style, {
            marginTop: '8px', padding: '8px',
            background: 'rgba(255,255,255,0.04)', borderRadius: '6px',
            border: '1px solid var(--line)'
          });
          const title = mk('div', '', (multi() ? pd.name + ' · ' : '') + pKey);
          Object.assign(title.style, { fontWeight: '700', marginBottom: '4px', color: '#fff' });
          block.appendChild(title);

          pd.infoFields.forEach(f => {
            if (f.col === pCol) return;
            const valLine = mk('div', '', f.col + ': ' + fieldValue(f, indices, pd));
            Object.assign(valLine.style, { fontSize: '11.5px', color: 'var(--muted)' });
            block.appendChild(valLine);
          });
          lines.push(block);
        });
      }
    }

    state.datasets.forEach(d => {
      if (pSheetId && d.id === pSheetId) return;
      const g = o.per[d.id];
      if (!g) return;
      d.infoFields.forEach(f => {
        lines.push((multi() ? d.name + ' · ' : '') + f.col + ' (' + aggLabel(f, d) + '): ' + fieldValue(f, g.idx, d));
      });
    });

    if (lines.length === 1) lines.push('Click "+ Add metric column" in Tab 1 to show details.');
    return lines;
  }

  function hitAt(x, y) {
    for (let i = state.hits.length - 1; i >= 0; i--) {
      const h = state.hits[i], dx = h.x - x, dy = h.y - y;
      if (dx * dx + dy * dy <= h.r * h.r) return h;
    }
    return null;
  }

  function setCursor(on) {
    if (!state.map || state.cursor === on) return;
    state.cursor = on;
    state.map.setOptions({ draggableCursor: on ? 'pointer' : null });
  }

  function onMouseMove(e) {
    if (e.buttons) return;
    const rect = $('#map').getBoundingClientRect();
    setCursor(!!hitAt(e.clientX - rect.left, e.clientY - rect.top));
  }

  function showCard(o) {
    state.pinnedPin = o.pin;
    const lines = describe(o);
    $('#cardTitle').textContent = lines[0];
    const body = $('#cardBody'); body.innerHTML = '';
    lines.slice(1).forEach(t => body.append(t instanceof HTMLElement ? t : mk('div', '', t)));
    $('#card').style.display = 'block';
  }

  function closeCard() { state.pinnedPin = null; $('#card').style.display = 'none'; }

  function refreshCard() {
    const o = state.pinnedPin && state.pointByPin.get(state.pinnedPin);
    if (o) showCard(o); else closeCard();
  }

  function onMapClick(e) {
    if (!state.ov || !e || !e.latLng) return;
    const proj = state.ov.getProjection(); if (!proj) return;
    const p = proj.fromLatLngToContainerPixel(e.latLng); if (!p) return;
    const hit = hitAt(p.x, p.y), o = hit && state.pointByPin.get(hit.pin);
    if (o) showCard(o); else closeCard();
  }

  function activeTests(d) {
    const tests = [];
    for (const [col, f] of Object.entries(d.filters)) {
      if (!isActive(f)) continue;
      if (f.type === 'cat') tests.push(r => f.sel.has(keyOf(r[col])));
      else if (f.type === 'num') tests.push(r => { const v = r[col]; return typeof v === 'number' && v >= f.lo && v <= f.hi; });
      else if (f.type === 'date') tests.push(r => { const v = r[col]; if (!(v instanceof Date)) return false; const t = v.getTime(); return t >= f.lo && t <= f.hi; });
      else if (f.type === 'text') tests.push(r => String(r[col] == null ? '' : r[col]).toLowerCase().includes(f.q));
    }
    return tests;
  }

  function groupRows() {
    for (const d of state.datasets) {
      const tests = activeTests(d);
      const g = new Map(), unm = new Map();
      let kept = 0, noPin = 0;
      for (let i = 0; i < d.rows.length; i++) {
        const r = d.rows[i];
        let ok = true;
        for (let k = 0; k < tests.length; k++) { if (!tests[k](r)) { ok = false; break; } }
        if (!ok) continue;
        kept++;
        const p = d.pins[i];
        if (!p) { noPin++; continue; }
        const ll = state.lookup.get(p);
        if (!ll) { unm.set(p, (unm.get(p) || 0) + 1); continue; }
        let o = g.get(p);
        if (!o) { o = { pin: p, lat: ll[0], lng: ll[1], n: 0, idx: [] }; g.set(p, o); }
        o.n++; o.idx.push(i);
      }
      d.groups = g; d.unm = unm; d.kept = kept; d.noPin = noPin;
      Object.values(d.filters).forEach(f => { if (f.el) f.el.classList.toggle('on', isActive(f)); });
    }
    updateFilterBadge();

    const u = new Map();
    state.datasets.forEach(d => d.groups.forEach((o, p) => {
      let x = u.get(p);
      if (!x) { x = { pin: p, lat: o.lat, lng: o.lng, per: {} }; u.set(p, x); }
      x.per[d.id] = o;
    }));
    state.pointByPin = u; state.points = [...u.values()];
    paintStats();
    $('#empty').style.display = (state.datasets.length && state.lookup.size && state.map) ? 'none' : 'flex';
  }

  function paintStats() {
    const unmAll = [];
    state.datasets.forEach(d => d.unm.forEach((c, p) => unmAll.push([d.name, p, c])));
    unmAll.sort((a, b) => b[2] - a[2]);
    state.unmatched = unmAll;
    $('#unmCount').textContent = unmAll.length;
    $('#unmBox').style.display = unmAll.length ? '' : 'none';
    $('#unmList').textContent = unmAll.slice(0, 200).map(([n, p, c]) => (multi() ? n + ': ' : '') + p + ' (' + c + ' rows)').join('\n');
  }

  function buildLayerData() {
    for (const L of state.layers) {
      const pts = []; let mn = Infinity, mx = 0;
      const d = dsOf(L);
      if (d) d.groups.forEach((o, pin) => {
        const v = layerCalc(L, o.idx);
        if (v > 0) { pts.push({ pin, lat: o.lat, lng: o.lng, q: v }); if (v > mx) mx = v; if (v < mn) mn = v; }
      });
      L.pts = pts; L.min = pts.length ? mn : 0; L.max = mx;
    }
  }

  function paintLayerNotes() {
    state.layers.forEach(L => {
      if (!L.noteEl) return;
      const d = dsOf(L); let msg = '';
      if (d && d.groups.size === 0) msg = 'No matching pincodes found on "' + d.name + '".';
      else if (d && !L.pts.length) msg = 'All values are 0 or empty for this metric.';
      L.noteEl.textContent = msg; L.noteEl.style.display = msg ? '' : 'none';
    });
  }

  function paintLegend() {
    const host = $('#legend'); host.innerHTML = '';
    state.layers.filter(L => L.visible).forEach(L => {
      const row = mk('div', 'lrow');
      const t = mk('div', 'lt');
      t.append(mk('span', '', labelOf(L)), mk('span', '', L.dots !== 'off' ? SHAPE_ICON[L.shape] : ''));
      const bar = mk('div', 'bar'); bar.style.background = RAMPS[L.ramp].css;
      const lg = mk('div', 'lg');
      if (L.pts.length) [0, .25, .5, .75, 1].forEach(x => lg.append(mk('span', '', nf1.format(unnorm(x, L.scale, L.max)))));
      else lg.append(mk('span', '', 'No data loaded'));
      row.append(t, bar, lg);
      if (L.pts.length) row.append(mk('div', 'ln', L.pts.length.toLocaleString() + ' pincodes · Max: ' + nf1.format(L.max)));
      host.append(row);
    });
  }

  function getStamp() {
    if (!state.stampCanvas) {
      const sc = document.createElement('canvas');
      sc.width = sc.height = 256;
      const sctx = sc.getContext('2d');
      const g = sctx.createRadialGradient(128, 128, 0, 128, 128, 128);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      sctx.fillStyle = g;
      sctx.fillRect(0, 0, 256, 256);
      state.stampCanvas = sc;
    }
    return state.stampCanvas;
  }

  function heatCanvas(L, rp, w, h, op, toPx) {
    if (!L._offCanvas) L._offCanvas = document.createElement('canvas');
    const off = L._offCanvas;
    if (off.width !== w) off.width = w;
    if (off.height !== h) off.height = h;
    const x = off.getContext('2d', { willReadFrequently: true });
    x.globalCompositeOperation = 'source-over';
    x.fillStyle = '#000';
    x.fillRect(0, 0, w, h);
    x.globalCompositeOperation = L.ovl === 'sum' ? 'lighter' : 'lighten';

    const stamp = getStamp(), diam = rp * 2;
    for (const d of L.pts) {
      const p = toPx(d); if (!p) continue;
      if (p.x < -rp || p.x > w + rp || p.y < -rp || p.y > h + rp) continue;
      const intensity = clamp(norm(d.q, L.scale, L.max), 0, 1);
      if (intensity <= 0) continue;
      x.globalAlpha = intensity;
      x.drawImage(stamp, p.x - rp, p.y - rp, diam, diam);
    }
    x.globalAlpha = 1;

    const img = x.getImageData(0, 0, w, h), px = img.data, lut = RAMPS[L.ramp].lut;
    for (let i = 0; i < px.length; i += 4) {
      const j = px[i] * 4;
      if (j === 0) { px[i + 3] = 0; continue; }
      px[i] = lut[j]; px[i + 1] = lut[j + 1]; px[i + 2] = lut[j + 2]; px[i + 3] = lut[j + 3] * op;
    }
    x.globalCompositeOperation = 'source-over';
    x.putImageData(img, 0, 0);
    return off;
  }

  function shapePath(ctx, shape, x, y, r) {
    ctx.beginPath();
    if (shape === 'square') ctx.rect(x - r, y - r, 2 * r, 2 * r);
    else if (shape === 'diamond') { const k = r * 1.3; ctx.moveTo(x, y - k); ctx.lineTo(x + k, y); ctx.lineTo(x, y + k); ctx.lineTo(x - k, y); ctx.closePath(); }
    else if (shape === 'triangle') { ctx.moveTo(x, y - r * 1.25); ctx.lineTo(x + r * 1.15, y + r * 0.95); ctx.lineTo(x - r * 1.15, y + r * 0.95); ctx.closePath(); }
    else ctx.arc(x, y, r, 0, 6.2832);
  }

  function drawDots(ctx, L, toPx) {
    const ramp = RAMPS[L.ramp];
    for (const d of L.pts) {
      const p = toPx(d); if (!p) continue;
      if (p.x < -20 || p.x > ctx.canvas.width + 20 || p.y < -20 || p.y > ctx.canvas.height + 20) continue;
      let r;
      if (L.heat === false) {
        r = 6;
        shapePath(ctx, L.shape, p.x, p.y, r);
        if (L.dots === 'ring') {
          ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.stroke();
          ctx.lineWidth = 2; ctx.strokeStyle = '#eab308'; ctx.stroke();
        } else {
          ctx.fillStyle = '#eab308'; ctx.fill();
          ctx.lineWidth = 1.5; ctx.strokeStyle = '#000'; ctx.stroke();
        }
      } else if (L.dots === 'ring') {
        r = 3 + 9 * Math.sqrt(clamp(d.q / L.max, 0, 1));
        shapePath(ctx, L.shape, p.x, p.y, r);
        ctx.lineWidth = 3.4; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.stroke();
        ctx.lineWidth = 1.8; ctx.strokeStyle = 'rgb(' + ramp.accent.join(',') + ')'; ctx.stroke();
      } else {
        r = 5;
        const j = Math.round(255 * clamp(norm(d.q, L.scale, L.max), 0, 1)) * 4;
        shapePath(ctx, L.shape, p.x, p.y, r);
        ctx.fillStyle = 'rgb(' + ramp.lut[j] + ',' + ramp.lut[j + 1] + ',' + ramp.lut[j + 2] + ')';
        ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(15,17,21,.9)'; ctx.stroke();
      }
      state.hits.push({ x: p.x, y: p.y, r: Math.max(r + 2, 7), pin: d.pin });
    }
  }

  function render() {
    state.hits = [];
    if (!state.map || !state.ov || !state.canvas) return;
    const proj = state.ov.getProjection(); if (!proj) return;
    const div = state.map.getDiv(), w = div.clientWidth, h = div.clientHeight;
    if (!w || !h) return;
    const cv = state.canvas;
    if (cv.width !== w) cv.width = w;
    if (cv.height !== h) cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    const km = +$('#radius').value, op = +$('#opacity').value;
    const c = state.map.getCenter(), lat = c ? c.lat() : 19.076;
    const mpp = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, state.map.getZoom());
    const rp = Math.max(6, km * 1000 / mpp);

    const cache = new Map();
    const toPx = d => {
      let p = cache.get(d.pin);
      if (p === undefined) {
        let ll = state.latLngCache.get(d.pin);
        if (!ll) { ll = new google.maps.LatLng(d.lat, d.lng); state.latLngCache.set(d.pin, ll); }
        p = proj.fromLatLngToContainerPixel(ll) || null;
        cache.set(d.pin, p);
      }
      return p;
    };

    const mapType = $('#basemap').value;
    ctx.globalCompositeOperation = (mapType === 'dark' || mapType === 'gray' || mapType === 'satellite') ? 'screen' : 'multiply';
    const order = state.layers.filter(L => L.visible && L.pts.length).reverse();
    order.forEach(L => { if (L.heat !== false) ctx.drawImage(heatCanvas(L, rp, w, h, op, toPx), 0, 0); });

    ctx.globalCompositeOperation = 'source-over';
    order.forEach(L => { if (L.dots !== 'off') drawDots(ctx, L, toPx); });
  }

  function fitToData() {
    if (!state.map || !state.points.length) return;
    let a = 90, b = -90, c = 180, e = -180;
    state.points.forEach(p => { a = Math.min(a, p.lat); b = Math.max(b, p.lat); c = Math.min(c, p.lng); e = Math.max(e, p.lng); });
    if (b - a < 0.02 && e - c < 0.02) { state.map.setCenter({ lat: (a + b) / 2, lng: (c + e) / 2 }); state.map.setZoom(12); return; }
    const bnd = new google.maps.LatLngBounds();
    bnd.extend({ lat: a, lng: c }); bnd.extend({ lat: b, lng: e });
    state.map.fitBounds(bnd, 40);
  }

  function jumpToPincode() {
    const pin = normPin($('#pinJump').value);
    if (!pin) return;
    const o = state.pointByPin.get(pin);
    const ll = state.lookup.get(pin);
    if (o && state.map) {
      state.map.setCenter({ lat: o.lat, lng: o.lng });
      state.map.setZoom(Math.max(state.map.getZoom(), 13));
      showCard(o);
    } else if (ll && state.map) {
      state.map.setCenter({ lat: ll[0], lng: ll[1] });
      state.map.setZoom(13);
    }
  }

  function restyle() { paintLegend(); scheduleRender(); }

  const refreshData = debounce(() => {
    groupRows(); buildLayerData(); paintLayerNotes(); paintLegend(); refreshCard();
    if (state.needFit && state.map && state.points.length) { state.needFit = false; fitToData(); }
    scheduleRender();
  }, 90);

  state.layers = [newLayer()];
  renderLayerUI();

  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e => {
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) loadData(f);
  });

  $('#addLayer').onclick = () => { state.layersTouched = true; state.layers.push(newLayer()); renderLayerUI(); refreshData(); };
  $('#addField').onclick = () => {
    const d = state.active;
    if (!d) return;
    const col = Object.keys(d.colType)[0];
    if (!col) return;
    d.infoFields.push({ col, agg: defaultAgg(d, col) });
    renderInfoUI();
    refreshCard();
  };

  // Download Sample Template Button Handler
  $('#dlTemplate').onclick = () => {
    const a = document.createElement('a');
    a.href = 'pincode_template.xlsx'; // Ensure this matches the exact filename in your GitHub repo
    a.download = 'pincode_template.xlsx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  $('#loadMap').onclick = startMap;
  $('#key').addEventListener('keydown', e => { if (e.key === 'Enter') startMap(); });
  $('#lookupFile').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    setStatus('#lookupStatus', 'Reading…');
    try { state.lookup = buildLookup(firstSheetRows(await readBuffer(f))); lookupReady(); }
    catch (err) { state.lookupOk = false; updateSetupPill(); setStatus('#lookupStatus', err.message, 'err'); }
  };
  $('#dataFile').onchange = e => { const f = e.target.files[0]; if (f) loadData(f); };

  $('#sheetSel').onchange = e => {
    state.active = dsById(+e.target.value); state.activeTouched = true;
    syncDataControls(); showSlicers(); renderInfoUI();
  };
  $('#filterSheetSel').onchange = e => {
    state.filterSheetId = +e.target.value;
    showSlicers();
  };
  $('#pinCol').onchange = e => {
    const d = state.active; if (!d) return;
    d.pinManual = true;
    setPinCol(d, e.target.value); analyze(d);
    if (d.slicerEl) { d.slicerEl.remove(); d.slicerEl = null; }
    showSlicers(); renderLayerUI(); renderInfoUI(); refreshData();
  };

  $('#radius').addEventListener('input', e => { $('#oRadius').textContent = (+e.target.value) + ' km'; scheduleRender(); });
  $('#opacity').addEventListener('input', e => { $('#oOpacity').textContent = e.target.value; scheduleRender(); });
  $('#basemap').onchange = applyBasemap;
  $('#cardX').onclick = closeCard;
  $('#zoomData').onclick = fitToData;
  $('#pinJumpBtn').onclick = jumpToPincode;
  $('#pinJump').addEventListener('keydown', e => { if (e.key === 'Enter') jumpToPincode(); });

  $('#resetSlicers').onclick = () => {
    const fId = state.filterSheetId || (state.active ? state.active.id : null);
    const d = dsById(fId); if (!d) return;
    analyze(d); buildSlicerUI(d); showSlicers(); renderLayerUI(); renderInfoUI(); refreshData();
  };
  $('#dlUnm').onclick = () => {
    const csv = 'Sheet,Pincode,Rows\n' + (state.unmatched || []).map(([n, p, c]) => '"' + n.replace(/"/g, '""') + '",' + p + ',' + c).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'unmatched_pincodes.csv'; a.click();
  };

  async function boot() {
    const key = CFG.GOOGLE_MAPS_API_KEY;
    if (key && !/PASTE|YOUR/i.test(key)) { $('#key').value = key; startMap(); }
    else { setStatus('#mapStatus', 'No API key found in config.js.', 'err'); $('#setupDrawer').classList.add('open'); }

    if (CFG.PINCODE_FILE) {
      try { state.lookup = buildLookup(firstSheetRows(await fetchBuffer(CFG.PINCODE_FILE))); lookupReady(); }
      catch (e) {
        setStatus('#lookupStatus', 'Could not load ' + CFG.PINCODE_FILE + '.', 'err');
        $('#setupDrawer').classList.add('open');
      }
    } else {
      setStatus('#lookupStatus', 'No PINCODE_FILE configured.', 'err');
      $('#setupDrawer').classList.add('open');
    }

    if (CFG.DATA_FILE) {
      try { ingestSheets(sheetsFromBuffer(await fetchBuffer(CFG.DATA_FILE))); }
      catch (e) { setStatus('#dataStatus', 'Could not auto-load ' + CFG.DATA_FILE, 'err'); }
    }
  }
  boot();
})();
