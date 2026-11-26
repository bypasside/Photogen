/* Photogen UI: connects index.html to PhotoEditor (editor.js) and AsciiEngine (ascii.js). */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const isHost = !!(window.chrome && window.chrome.webview);
  const wait = (fn) => requestAnimationFrame(fn);

  // ============================================================ helpers
  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
  }

  const blobToBase64 = (blob) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });

  /** Native Save dialog inside the exe, regular download in a browser. */
  async function saveBlob(blob, name) {
    if (isHost) {
      window.chrome.webview.postMessage(JSON.stringify({ type: 'save', name, data: await blobToBase64(blob) }));
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Сохранено: ' + name);
  }
  const saveText = (text, name, mime = 'text/plain') => saveBlob(new Blob([text], { type: mime + ';charset=utf-8' }), name);

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Скопировано');
  }

  const loadImageFromFile = (file) => new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('bad image')); };
    img.src = url;
  });

  let baseName = 'image';
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');

  if (isHost) {
    window.chrome.webview.addEventListener('message', (e) => {
      let m = e.data;
      if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return; } }
      if (m.type === 'saved') toast('Сохранено: ' + m.path);
      if (m.type === 'error') toast('Ошибка: ' + m.message);
    });
  }

  // ============================================================ tooltips
  const tip = $('tooltip');
  let tipTimer;
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest('[data-tip]');
    clearTimeout(tipTimer);
    if (!el) { tip.classList.remove('show'); return; }
    tipTimer = setTimeout(() => {
      tip.textContent = el.dataset.tip.replace(/\s{2,}/, '    ');
      const r = el.getBoundingClientRect();
      const inToolbar = !!el.closest('.toolbar');
      tip.classList.add('show');
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let x = inToolbar ? r.right + 10 : r.left + r.width / 2 - tw / 2;
      let y = inToolbar ? r.top + r.height / 2 - th / 2 : (r.bottom + th + 12 > innerHeight ? r.top - th - 8 : r.bottom + 8);
      x = Math.max(6, Math.min(innerWidth - tw - 6, x));
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
    }, 450);
  });
  document.addEventListener('pointerdown', () => { clearTimeout(tipTimer); tip.classList.remove('show'); });

  // collapsible panes
  $$('.pane-h').forEach((h) => {
    if (!h.querySelector('.chev')) return;
    h.addEventListener('click', (e) => { if (!e.target.closest('.link')) h.parentElement.classList.toggle('open'); });
  });

  // segmented controls: generic active switching
  function seg(id, onPick) {
    const box = $(id);
    $$('button', box).forEach((b) => b.addEventListener('click', () => {
      $$('button', box).forEach((x) => x.classList.toggle('active', x === b));
      onPick(b);
    }));
  }

  // ============================================================ core
  const canvas = $('mainCanvas');
  const stage = $('stage');
  const ed = new PhotoEditor(canvas);

  // ============================================================ tabs
  let currentTab = 'editor';
  function showTab(name) {
    currentTab = name;
    $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    // undo, redo and photo export belong to the editor only
    ['exportWrap', 'btnUndo', 'btnRedo'].forEach((id) => { $(id).hidden = name !== 'editor'; });
    if (name === 'ascii') scheduleAscii();
    else if (name === 'gif') gifOnShow();
    else wait(applyZoom);
  }
  $$('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ============================================================ open files
  const fileInput = $('fileInput');
  const openDialog = () => fileInput.click();
  ['btnOpen', 'dzOpen', 'asciiOpen', 'asciiEmptyOpen'].forEach((id) =>
    $(id).addEventListener('click', (e) => { e.stopPropagation(); openDialog(); }));
  $('dropzone').addEventListener('click', openDialog);
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) openFile(fileInput.files[0]);
    fileInput.value = '';
  });

  async function openFile(file) {
    if (!file || !file.type.startsWith('image/')) { toast('Это не изображение'); return; }
    if (file.type === 'image/gif' && await openGif(file)) return;
    try {
      const img = await loadImageFromFile(file);
      baseName = (file.name || 'image').replace(/\.[^.]+$/, '') || 'image';
      setImage(img);
      if (currentTab === 'gif') showTab('editor');
    } catch {
      toast('Не удалось открыть файл');
    }
  }

  function setImage(src) {
    ed.loadImage(src);
    canvas.hidden = false;
    $('dropzone').hidden = true;
    selectTool('none');
    buildFilterThumbs(src);
    syncAdjustSliders();
    syncResizeFields();
    syncCurve();
    asciiSourceDirty = true;
    zoomFit = true;
    applyZoom();
    updateUI();
    scheduleHistogram();
  }

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropOverlay').classList.add('show'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').classList.remove('show'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropOverlay').classList.remove('show');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) openFile(f);
  });
  window.addEventListener('paste', (e) => {
    if (e.target.matches('input, textarea')) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) openFile(item.getAsFile());
  });

  // ============================================================ zoom and pan
  let zoom = 1;
  let zoomFit = true;
  const ZOOMS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16];

  function fitScale() {
    const pad = 80;
    const w = stage.clientWidth - pad, h = stage.clientHeight - pad;
    if (!canvas.width || w <= 0 || h <= 0) return 1;
    return Math.min(1, w / canvas.width, h / canvas.height);
  }
  function applyZoom() {
    if (!ed.hasImage()) return;
    if (zoomFit) zoom = fitScale();
    canvas.style.width = Math.max(1, Math.round(canvas.width * zoom)) + 'px';
    canvas.style.height = Math.max(1, Math.round(canvas.height * zoom)) + 'px';
    canvas.classList.toggle('pixel', zoom >= 3);
    $('zoomVal').textContent = Math.round(zoom * 100) + '%';
  }
  /** Zoom keeping the image point under (cx, cy) (client coords) in place. */
  function setZoom(z, cx, cy) {
    if (!ed.hasImage()) return;
    z = Math.max(0.02, Math.min(32, z));
    const r = canvas.getBoundingClientRect();
    if (cx === undefined) { const s = stage.getBoundingClientRect(); cx = s.left + s.width / 2; cy = s.top + s.height / 2; }
    const ix = (cx - r.left) / zoom, iy = (cy - r.top) / zoom;
    zoomFit = false;
    zoom = z;
    applyZoom();
    const r2 = canvas.getBoundingClientRect();
    stage.scrollLeft += (r2.left + ix * zoom) - cx;
    stage.scrollTop += (r2.top + iy * zoom) - cy;
  }
  const stepZoom = (dir, cx, cy) => {
    const next = dir > 0 ? ZOOMS.find((z) => z > zoom + 1e-6) : [...ZOOMS].reverse().find((z) => z < zoom - 1e-6);
    setZoom(next ?? zoom, cx, cy);
  };
  $('zoomIn').addEventListener('click', () => stepZoom(1));
  $('zoomOut').addEventListener('click', () => stepZoom(-1));
  $('zoomVal').addEventListener('click', () => setZoom(1));
  $('zoomFit').addEventListener('click', () => { zoomFit = true; applyZoom(); });
  stage.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !ed.hasImage()) return;
    e.preventDefault();
    setZoom(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
  }, { passive: false });
  new ResizeObserver(() => { if (zoomFit) applyZoom(); }).observe(stage);

  // pan: hand tool, or hold Space with any tool
  let spaceHeld = false;
  let savedCursor = '';
  let pan = null;
  stage.addEventListener('pointerdown', (e) => {
    if (!ed.hasImage() || e.button !== 0) return;
    if (!(spaceHeld || ed.getTool() === 'none') && e.target === canvas) return;
    if (e.target.closest('.dropzone')) return;
    e.stopPropagation();
    e.preventDefault();
    pan = { x: e.clientX, y: e.clientY, sl: stage.scrollLeft, st: stage.scrollTop, id: e.pointerId };
    try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    stage.classList.add('panning');
  }, true);
  stage.addEventListener('pointermove', (e) => {
    if (!pan) return;
    stage.scrollLeft = pan.sl - (e.clientX - pan.x);
    stage.scrollTop = pan.st - (e.clientY - pan.y);
  });
  const endPan = () => { if (!pan) return; pan = null; stage.classList.remove('panning'); };
  stage.addEventListener('pointerup', endPan);
  stage.addEventListener('pointercancel', endPan);

  // ============================================================ tools
  const TOOL_CURSOR_HINT = { none: 'grab' };
  function selectTool(tool) {
    if (ed.getTool() === 'crop' && tool !== 'crop') ed.cancelCrop();
    ed.setTool(tool);
    $$('.tl[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    $$('#optbar .opt').forEach((o) => { o.hidden = !o.dataset.for.split(' ').includes(tool); });
    if (TOOL_CURSOR_HINT[tool]) canvas.style.cursor = TOOL_CURSOR_HINT[tool];
  }
  $$('.tl[data-tool]').forEach((b) => b.addEventListener('click', () => {
    if (!ed.hasImage()) { toast('Сначала откройте изображение'); return; }
    selectTool(b.dataset.tool);
  }));
  const actions = { rotL: () => ed.rotate(-90), rotR: () => ed.rotate(90), flipH: () => ed.flip('h'), flipV: () => ed.flip('v') };
  $$('.tl[data-action]').forEach((b) => b.addEventListener('click', () => {
    if (!ed.hasImage()) { toast('Сначала откройте изображение'); return; }
    actions[b.dataset.action]();
  }));

  function bindRange(id, fn, fmt = (v) => v) {
    const el = $(id), out = $(id + 'V');
    el.addEventListener('input', () => { if (out) out.textContent = fmt(el.value); fn(+el.value); });
  }

  // main color shared by brush, shapes and text
  function setMainColor(hex) {
    $('mainColor').value = hex;
    $('swatchFill').style.background = hex;
    ed.setBrush({ color: hex });
    ed.setText({ color: hex });
    ed.setShape({ color: hex });
  }
  $('mainColor').addEventListener('input', (e) => setMainColor(e.target.value));

  bindRange('brushSize', (v) => ed.setBrush({ size: v }));
  bindRange('brushOp', (v) => ed.setBrush({ opacity: v / 100 }));
  ed.setBrush({ size: 12, opacity: 1 });

  seg('shapeType', (b) => ed.setShape({ type: b.dataset.v }));
  bindRange('shapeSize', (v) => ed.setShape({ size: v }));
  $('shapeFill').addEventListener('input', (e) => ed.setShape({ fill: e.target.checked }));
  ed.setShape({ type: 'rect', size: 4, fill: false });

  const pushText = () => ed.setText({
    text: $('textValue').value, size: +$('textSize').value, font: $('textFont').value, bold: $('textBold').checked,
  });
  ['textValue', 'textFont', 'textBold'].forEach((id) => $(id).addEventListener('input', pushText));
  bindRange('textSize', pushText);
  pushText();
  setMainColor('#ffffff');

  seg('cropRatios', (b) => ed.setCropRatio(b.dataset.r === 'free' ? null : +b.dataset.r));
  const doCrop = () => { ed.applyCrop(); selectTool('none'); };
  $('cropApply').addEventListener('click', doCrop);
  $('cropCancel').addEventListener('click', () => { ed.cancelCrop(); selectTool('none'); });

  ed.onPick((hex) => {
    setMainColor(hex);
    $('pickedInfo').innerHTML = `<i style="background:${hex}"></i>${hex.toUpperCase()}`;
  });

  // ============================================================ filters
  const FILTERS = [
    ['none', 'Оригинал'], ['grayscale', 'Ч/Б'], ['sepia', 'Сепия'], ['vintage', 'Винтаж'],
    ['warm', 'Тёплый'], ['cold', 'Холодный'], ['noir', 'Нуар'], ['dramatic', 'Драма'],
    ['pop', 'Поп'], ['fade', 'Выцветший'], ['cyber', 'Кибер'], ['invert', 'Негатив'],
  ];
  const filterBox = $('filters');
  FILTERS.forEach(([key, label]) => {
    const b = document.createElement('button');
    b.className = 'filter' + (key === 'none' ? ' active' : '');
    b.dataset.f = key;
    b.innerHTML = `<canvas width="120" height="120"></canvas><span>${label}</span>`;
    b.addEventListener('click', () => { if (ed.hasImage()) ed.applyFilter(key); });
    filterBox.appendChild(b);
  });
  const markFilter = () => {
    const f = ed.getFilter();
    $$('.filter', filterBox).forEach((b) => b.classList.toggle('active', b.dataset.f === f));
  };
  function buildFilterThumbs(src) {
    const size = 120;
    const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
    const s = Math.min(sw, sh);
    const thumb = document.createElement('canvas');
    thumb.width = thumb.height = size;
    const tctx = thumb.getContext('2d');
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(src, (sw - s) / 2, (sh - s) / 2, s, s, 0, 0, size, size);
    try {
      const tmp = new PhotoEditor(document.createElement('canvas'));
      tmp.loadImage(thumb);
      $$('.filter', filterBox).forEach((b) => {
        tmp.applyFilter(b.dataset.f);
        const c = b.querySelector('canvas').getContext('2d');
        c.clearRect(0, 0, size, size);
        c.drawImage(tmp.getCanvas(), 0, 0, size, size);
      });
      if (tmp.destroy) tmp.destroy();
    } catch (err) { console.warn('filter thumbs', err); }
  }

  // ============================================================ adjustments
  const ADJ = [
    ['exposure', 'Экспозиция', -100, 100], ['brightness', 'Яркость', -100, 100],
    ['contrast', 'Контраст', -100, 100], ['highlights', 'Света', -100, 100],
    ['shadows', 'Тени', -100, 100], ['saturation', 'Насыщенность', -100, 100],
    ['temperature', 'Температура', -100, 100], ['tint', 'Оттенок', -100, 100],
    ['hue', 'Цветовой тон', -180, 180], ['sharpen', 'Резкость', 0, 100],
    ['blur', 'Размытие', 0, 20], ['vignette', 'Виньетка', 0, 100], ['noise', 'Зерно', 0, 100],
  ];
  const adjEls = {};
  ADJ.forEach(([key, label, min, max]) => {
    const wrap = document.createElement('label');
    wrap.className = 'slider';
    wrap.title = 'Двойной клик сбрасывает';
    wrap.innerHTML = `<span>${label} <b>0</b></span><input type="range" min="${min}" max="${max}" value="0">`;
    const input = wrap.querySelector('input'), out = wrap.querySelector('b');
    const upd = () => { out.textContent = input.value; wrap.classList.toggle('changed', +input.value !== 0); };
    input.addEventListener('input', () => { if (!ed.hasImage()) return; upd(); ed.setAdjustment(key, +input.value); });
    input.addEventListener('change', () => { if (ed.hasImage()) { ed.commit(); scheduleHistogram(); } });
    wrap.addEventListener('dblclick', (e) => {
      e.preventDefault();
      input.value = 0; upd();
      if (ed.hasImage()) { ed.setAdjustment(key, 0); ed.commit(); }
    });
    adjEls[key] = { input, upd };
    $('adjustments').appendChild(wrap);
  });
  function syncAdjustSliders() {
    if (!ed.hasImage()) return;
    const a = ed.getAdjustments();
    for (const k in adjEls) { adjEls[k].input.value = a[k] ?? 0; adjEls[k].upd(); }
  }
  $('adjReset').addEventListener('click', () => { if (ed.hasImage()) { ed.resetAdjustments(); syncAdjustSliders(); syncCurve(); } });

  // ============================================================ curves
  const cv = $('curveCanvas');
  const cctx = cv.getContext('2d');
  let curvePts = [[0, 0], [255, 255]];
  let histo = null;
  let dragPt = -1;

  function curveLUT(pts) {
    // monotone cubic (Fritsch Carlson), used only for drawing; the engine computes its own
    const n = pts.length, xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const d = [], m = new Array(n);
    for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
      if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    const lut = new Float32Array(256);
    for (let x = 0; x < 256; x++) {
      let k = 0;
      while (k < n - 2 && x > xs[k + 1]) k++;
      if (x <= xs[0]) { lut[x] = ys[0]; continue; }
      if (x >= xs[n - 1]) { lut[x] = ys[n - 1]; continue; }
      const h = xs[k + 1] - xs[k], t = (x - xs[k]) / h, t2 = t * t, t3 = t2 * t;
      lut[x] = (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1];
    }
    return lut;
  }

  function drawCurve() {
    const W = cv.width, H = cv.height, s = W / 255;
    cctx.clearRect(0, 0, W, H);
    if (histo) {
      cctx.fillStyle = '#1b1b1b';
      const max = Math.max(...histo) || 1;
      for (let i = 0; i < 256; i++) {
        const h = Math.pow(histo[i] / max, 0.6) * H * 0.9;
        cctx.fillRect(i * s, H - h, s + 0.5, h);
      }
    }
    cctx.strokeStyle = '#1e1e1e';
    cctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const p = Math.round(i * W / 4) + 0.5;
      cctx.beginPath(); cctx.moveTo(p, 0); cctx.lineTo(p, H); cctx.moveTo(0, p); cctx.lineTo(W, p); cctx.stroke();
    }
    cctx.strokeStyle = '#333';
    cctx.setLineDash([6, 6]);
    cctx.beginPath(); cctx.moveTo(0, H); cctx.lineTo(W, 0); cctx.stroke();
    cctx.setLineDash([]);
    const lut = curveLUT(curvePts);
    cctx.strokeStyle = '#fff';
    cctx.lineWidth = 3;
    cctx.beginPath();
    for (let x = 0; x < 256; x++) {
      const y = H - Math.max(0, Math.min(255, lut[x])) * s;
      x ? cctx.lineTo(x * s, y) : cctx.moveTo(0, y);
    }
    cctx.stroke();
    curvePts.forEach(([x, y], i) => {
      cctx.beginPath();
      cctx.arc(x * s, H - y * s, i === dragPt ? 11 : 9, 0, Math.PI * 2);
      cctx.fillStyle = '#000';
      cctx.fill();
      cctx.lineWidth = 3;
      cctx.strokeStyle = '#fff';
      cctx.stroke();
    });
  }
  const curvePos = (e) => {
    const r = cv.getBoundingClientRect();
    return [
      Math.max(0, Math.min(255, (e.clientX - r.left) / r.width * 255)),
      Math.max(0, Math.min(255, 255 - (e.clientY - r.top) / r.height * 255)),
    ];
  };
  const hitPoint = (x, y) => {
    let best = -1, bd = 12;
    curvePts.forEach(([px, py], i) => { const d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = i; } });
    return best;
  };
  cv.addEventListener('pointerdown', (e) => {
    if (!ed.hasImage()) return;
    const [x, y] = curvePos(e);
    dragPt = hitPoint(x, y);
    if (dragPt < 0) {
      curvePts.push([x, y]);
      curvePts.sort((a, b) => a[0] - b[0]);
      dragPt = curvePts.findIndex((p) => p[0] === x && p[1] === y);
    }
    try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    ed.setCurve(curvePts.map((p) => [Math.round(p[0]), Math.round(p[1])]));
    drawCurve();
  });
  cv.addEventListener('pointermove', (e) => {
    if (dragPt < 0) return;
    let [x, y] = curvePos(e);
    const last = curvePts.length - 1;
    if (dragPt === 0) x = 0;
    else if (dragPt === last) x = 255;
    else x = Math.max(curvePts[dragPt - 1][0] + 2, Math.min(curvePts[dragPt + 1][0] - 2, x));
    curvePts[dragPt] = [x, y];
    ed.setCurve(curvePts.map((p) => [Math.round(p[0]), Math.round(p[1])]));
    drawCurve();
  });
  const endCurve = () => {
    if (dragPt < 0) return;
    dragPt = -1;
    ed.commit();
    drawCurve();
  };
  cv.addEventListener('pointerup', endCurve);
  cv.addEventListener('pointercancel', endCurve);
  cv.addEventListener('dblclick', (e) => {
    const [x, y] = curvePos(e);
    const i = hitPoint(x, y);
    if (i > 0 && i < curvePts.length - 1) {
      curvePts.splice(i, 1);
      ed.setCurve(curvePts.map((p) => [Math.round(p[0]), Math.round(p[1])]));
      ed.commit();
      drawCurve();
    }
  });
  $('curveReset').addEventListener('click', () => {
    if (!ed.hasImage()) return;
    curvePts = [[0, 0], [255, 255]];
    ed.setCurve(curvePts);
    ed.commit();
    drawCurve();
  });
  function syncCurve() {
    if (ed.hasImage()) curvePts = ed.getCurve().map((p) => [p[0], p[1]]);
    drawCurve();
  }

  let histoTimer;
  function scheduleHistogram() {
    clearTimeout(histoTimer);
    histoTimer = setTimeout(() => {
      if (!ed.hasImage()) return;
      const src = ed.getCanvas();
      const c = document.createElement('canvas');
      const k = Math.min(1, 256 / Math.max(src.width, src.height));
      c.width = Math.max(1, Math.round(src.width * k));
      c.height = Math.max(1, Math.round(src.height * k));
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(src, 0, 0, c.width, c.height);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      histo = new Uint32Array(256);
      for (let i = 0; i < d.length; i += 4) histo[(d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8]++;
      drawCurve();
    }, 250);
  }

  // ============================================================ history
  let historySig = '';
  function renderHistory() {
    const h = ed.getHistory();
    const sig = h.index + '|' + h.items.map((i) => i.label).join(',');
    if (sig === historySig) return;
    historySig = sig;
    const ol = $('history');
    ol.innerHTML = '';
    h.items.forEach((it, i) => {
      const li = document.createElement('li');
      li.textContent = it.label;
      if (i === h.index) li.className = 'current';
      else if (i > h.index) li.className = 'future';
      li.addEventListener('click', () => { ed.jumpTo(i); afterHistory(); });
      ol.appendChild(li);
    });
    const cur = ol.querySelector('.current');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  // ============================================================ resize, clear
  let lockRatio = true;
  $('resLock').addEventListener('click', () => { lockRatio = !lockRatio; $('resLock').classList.toggle('on', lockRatio); });
  function syncResizeFields() {
    if (!ed.hasImage()) return;
    const s = ed.getSize();
    $('resW').value = s.width;
    $('resH').value = s.height;
  }
  $('resW').addEventListener('input', () => {
    if (!lockRatio || !ed.hasImage()) return;
    const s = ed.getSize();
    $('resH').value = Math.max(1, Math.round(+$('resW').value * s.height / s.width));
  });
  $('resH').addEventListener('input', () => {
    if (!lockRatio || !ed.hasImage()) return;
    const s = ed.getSize();
    $('resW').value = Math.max(1, Math.round(+$('resH').value * s.width / s.height));
  });
  $('resApply').addEventListener('click', () => {
    if (!ed.hasImage()) return;
    const w = Math.round(+$('resW').value), h = Math.round(+$('resH').value);
    if (!(w > 0 && h > 0 && w <= 8192 && h <= 8192)) { toast('Допустимо от 1 до 8192 px'); return; }
    ed.resize(w, h);
  });
  $('clearPaint').addEventListener('click', () => { if (ed.hasImage()) ed.clearPaint(); });

  // ============================================================ compare
  function setCompare(on) {
    if (!ed.hasImage()) return;
    ed.setCompare(on);
    $('btnCompare').classList.toggle('on', on);
  }
  $('btnCompare').addEventListener('pointerdown', (e) => { e.preventDefault(); setCompare(true); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => $('btnCompare').addEventListener(t, () => setCompare(false)));

  // ============================================================ export (photo)
  let exportType = 'image/png';
  const pop = $('exportPop');
  $('btnExport').addEventListener('click', (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; });
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !e.target.closest('.pop-wrap')) pop.hidden = true; });
  seg('exportFmt', (b) => { exportType = b.dataset.v; $('exportQWrap').hidden = exportType === 'image/png'; });
  bindRange('exportQ', () => {});
  async function exportPhoto() {
    if (!ed.hasImage()) return;
    pop.hidden = true;
    const ext = exportType.split('/')[1].replace('jpeg', 'jpg');
    saveBlob(await ed.toBlob(exportType, +$('exportQ').value / 100), `${baseName}_edit.${ext}`);
  }
  $('exportBtn').addEventListener('click', exportPhoto);
  $('toAscii').addEventListener('click', () => showTab('ascii'));

  // ============================================================ undo, state
  $('btnUndo').addEventListener('click', () => { ed.undo(); afterHistory(); });
  $('btnRedo').addEventListener('click', () => { ed.redo(); afterHistory(); });
  function afterHistory() { syncAdjustSliders(); syncCurve(); scheduleHistogram(); }

  let lastW = 0, lastH = 0;
  function updateUI() {
    const has = ed.hasImage();
    $('btnUndo').disabled = !has || !ed.canUndo();
    $('btnRedo').disabled = !has || !ed.canRedo();
    $('btnExport').disabled = !has;
    if (!has) return;
    const s = ed.getSize();
    $('imgInfo').textContent = `${s.width} × ${s.height} px`;
    if (s.width !== lastW || s.height !== lastH) {
      lastW = s.width; lastH = s.height;
      syncResizeFields();
      wait(applyZoom);
    }
    markFilter();
    renderHistory();
  }
  ed.onChange(() => {
    updateUI();
    asciiSourceDirty = true;
    if (currentTab === 'ascii' && asciiSrc === 'photo') scheduleAscii();
  });

  // ============================================================ keyboard
  window.addEventListener('keydown', (e) => {
    const typing = e.target.matches('input[type=text], input[type=number], textarea, select');
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (e.code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); ed.undo(); afterHistory(); }
      else if (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey)) { e.preventDefault(); ed.redo(); afterHistory(); }
      else if (e.code === 'KeyO') { e.preventDefault(); openDialog(); }
      else if (e.code === 'KeyS') { e.preventDefault(); currentTab === 'ascii' ? exportAsciiPng() : currentTab === 'gif' ? gifExport() : exportPhoto(); }
      else if (currentTab === 'editor' && (k === '=' || k === '+')) { e.preventDefault(); stepZoom(1); }
      else if (currentTab === 'editor' && k === '-') { e.preventDefault(); stepZoom(-1); }
      else if (currentTab === 'editor' && k === '0') { e.preventDefault(); zoomFit = true; applyZoom(); }
      else if (currentTab === 'editor' && k === '1') { e.preventDefault(); setZoom(1); }
      return;
    }
    if (!typing && currentTab === 'gif') {
      if (e.code === 'Space') { e.preventDefault(); gifTogglePlay(); }
      else if (e.key === ',' || e.key === 'ArrowLeft') { e.preventDefault(); gifStep(-1); }
      else if (e.key === '.' || e.key === 'ArrowRight') { e.preventDefault(); gifStep(1); }
      return;
    }
    if (typing || currentTab !== 'editor' || !ed.hasImage()) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (!spaceHeld) { spaceHeld = true; savedCursor = canvas.style.cursor; canvas.style.cursor = 'grab'; }
      return;
    }
    if (e.code === 'Backslash') { if (!e.repeat) setCompare(true); return; }
    const map = { KeyH: 'none', KeyV: 'none', KeyC: 'crop', KeyB: 'brush', KeyE: 'eraser', KeyT: 'text', KeyU: 'shape', KeyI: 'eyedropper' };
    if (map[e.code]) selectTool(map[e.code]);
    if (e.key === 'Enter' && ed.getTool() === 'crop') doCrop();
    if (e.key === 'Escape' && ed.getTool() === 'crop') { ed.cancelCrop(); selectTool('none'); }
    if (e.key === '[' || e.key === ']') {
      const el = $('brushSize');
      el.value = Math.max(1, Math.min(200, +el.value + (e.key === ']' ? 4 : -4)));
      el.dispatchEvent(new Event('input'));
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && spaceHeld) { spaceHeld = false; canvas.style.cursor = savedCursor; }
    if (e.code === 'Backslash') setCompare(false);
  });

  // ============================================================ ASCII
  let asciiSrc = 'photo';
  let asciiSourceDirty = true;
  let asciiSourceCache = null;
  let lastResult = null;
  let asciiView = 'image';

  seg('srcSeg', (b) => {
    asciiSrc = b.dataset.src;
    $('srcPhoto').hidden = asciiSrc !== 'photo';
    $('srcText').hidden = asciiSrc !== 'text';
    asciiSourceDirty = true;
    scheduleAscii();
  });
  seg('viewSeg', (b) => { asciiView = b.dataset.v; scheduleAscii(); });

  const asciiFmt = { aGamma: (v) => (v / 100).toFixed(2), aZoom: (v) => v + '%' };
  ['aWidth', 'aTol', 'aBright', 'aContrast', 'aGamma', 'aEdge', 'aFont', 'aGlow', 'aZoom'].forEach((id) =>
    bindRange(id, () => { clearPresetMark(); scheduleAscii(); }, asciiFmt[id]));
  ['aCharset', 'aCustom', 'aInvert', 'aRemoveBg', 'aDither', 'aSharpen', 'aEdges', 'aColorMode', 'aFg', 'aFg2', 'aBg', 'aTransparent']
    .forEach((id) => $(id).addEventListener('input', () => { clearPresetMark(); scheduleAscii(); }));
  ['asciiText', 'asciiTextFont'].forEach((id) => $(id).addEventListener('input', () => { asciiSourceDirty = true; scheduleAscii(); }));

  const readAsciiOpts = () => ({
    width: +$('aWidth').value,
    charset: $('aCharset').value,
    customChars: $('aCustom').value || ' .#',
    invert: $('aInvert').checked,
    removeBg: $('aRemoveBg').checked,
    bgTolerance: +$('aTol').value,
    brightness: +$('aBright').value,
    contrast: +$('aContrast').value,
    gamma: +$('aGamma').value / 100,
    dither: $('aDither').checked,
    sharpen: $('aSharpen').checked,
    edges: $('aEdges').checked,
    edgeThreshold: +$('aEdge').value,
  });
  const readAsciiStyle = (extra = {}) => Object.assign({
    fontSize: +$('aFont').value,
    colorMode: $('aColorMode').value,
    fg: $('aFg').value,
    fg2: $('aFg2').value,
    bg: $('aBg').value,
    transparentBg: $('aTransparent').checked,
    glow: +$('aGlow').value,
    scale: 1,
  }, extra);

  function getAsciiSource() {
    if (!asciiSourceDirty && asciiSourceCache) return asciiSourceCache;
    asciiSourceCache = asciiSrc === 'photo'
      ? (ed.hasImage() ? ed.getCanvas() : null)
      : AsciiEngine.textToCanvas($('asciiText').value.trim() || ' ', { font: $('asciiTextFont').value });
    asciiSourceDirty = false;
    return asciiSourceCache;
  }

  let asciiQueued = false;
  function scheduleAscii() {
    if (asciiQueued) return;
    asciiQueued = true;
    wait(() => { asciiQueued = false; renderAscii(); });
  }

  function renderAscii() {
    if (currentTab !== 'ascii') return;
    $('aCustom').hidden = $('aCharset').value !== 'custom';
    $('aTolWrap').hidden = !$('aRemoveBg').checked;
    $('aEdgeWrap').hidden = !$('aEdges').checked;
    $('aFg2Wrap').hidden = $('aColorMode').value !== 'gradient';
    $('srcPhotoHint').textContent = ed.hasImage()
      ? 'Используется изображение из редактора со всеми правками.'
      : 'Изображение ещё не открыто.';

    const src = getAsciiSource();
    const empty = !src;
    $('asciiEmpty').hidden = !empty;
    $('asciiCanvas').hidden = empty || asciiView !== 'image';
    $('asciiPre').hidden = empty || asciiView !== 'text';
    if (empty) { lastResult = null; $('asciiInfo').textContent = ''; return; }

    try { lastResult = AsciiEngine.convert(src, readAsciiOpts()); } catch (err) { console.error(err); toast('Ошибка преобразования'); return; }
    const style = readAsciiStyle();
    const z = +$('aZoom').value / 100;
    if (asciiView === 'image') {
      const c = $('asciiCanvas');
      AsciiEngine.render(lastResult, c, style);
      c.style.width = Math.round(c.width * z) + 'px';
      c.style.height = Math.round(c.height * z) + 'px';
    } else {
      const pre = $('asciiPre');
      pre.textContent = lastResult.text;
      pre.style.fontSize = style.fontSize * z + 'px';
      pre.style.color = style.fg;
      pre.style.background = style.transparentBg ? 'transparent' : style.bg;
    }
    $('asciiInfo').textContent = `${lastResult.cols} × ${lastResult.rows} символов`;
  }

  const PRESETS = [
    { name: 'Монохром', dot: '#ffffff', set: { aCharset: 'standard', aColorMode: 'mono', aFg: '#ffffff', aBg: '#000000', aGlow: 0, aInvert: true } },
    { name: 'Бумага', dot: '#f2efe8', set: { aCharset: 'standard', aColorMode: 'mono', aFg: '#111111', aBg: '#f2efe8', aGlow: 0, aInvert: false } },
    { name: 'Цвет', dot: 'linear-gradient(135deg,#f6a,#fc6,#6cf)', set: { aCharset: 'detailed', aColorMode: 'original', aBg: '#000000', aGlow: 0, aInvert: true } },
    { name: 'Графит', dot: 'linear-gradient(#fff,#555)', set: { aCharset: 'detailed', aColorMode: 'gradient', aFg: '#ffffff', aFg2: '#4a4a4a', aBg: '#000000', aGlow: 0, aInvert: true } },
    { name: 'Матрица', dot: '#00ff66', set: { aCharset: 'binary', aColorMode: 'mono', aFg: '#00ff66', aBg: '#000000', aGlow: 4, aInvert: true } },
    { name: 'Янтарь', dot: '#ffb000', set: { aCharset: 'hacker', aColorMode: 'mono', aFg: '#ffb000', aBg: '#000000', aGlow: 5, aInvert: true } },
    { name: 'Блоки', dot: '#bbbbbb', set: { aCharset: 'blocks', aColorMode: 'mono', aFg: '#e6e6e6', aBg: '#000000', aGlow: 0, aInvert: true } },
    { name: 'Брайль', dot: '#888888', set: { aCharset: 'dots', aColorMode: 'mono', aFg: '#ffffff', aBg: '#000000', aGlow: 0, aInvert: true } },
  ];
  // the same style chips appear in the ASCII tab and in the GIF tab (ASCII mode)
  const presetBoxes = [$('asciiPresets'), $('gifPresets')];
  function clearPresetMark() { presetBoxes.forEach((box) => $$('.preset', box).forEach((p) => p.classList.remove('active'))); }
  function applyPreset(idx) {
    for (const [id, v] of Object.entries(PRESETS[idx].set)) {
      const el = $(id);
      if (el.type === 'checkbox') el.checked = v; else el.value = v;
      const out = $(id + 'V');
      if (out) out.textContent = v;
    }
    clearPresetMark();
    presetBoxes.forEach((box) => $$('.preset', box)[idx].classList.add('active'));
    scheduleAscii();
    gifRefresh();
  }
  presetBoxes.forEach((box) => PRESETS.forEach((p, idx) => {
    const b = document.createElement('button');
    b.className = 'preset' + (idx === 0 ? ' active' : '');
    b.innerHTML = `<i style="background:${p.dot}"></i>${p.name}`;
    b.addEventListener('click', () => applyPreset(idx));
    box.appendChild(b);
  }));
  // apply the default preset values to the controls
  $('aInvert').checked = true;

  const need = () => { if (!lastResult) { toast('Сначала создайте логотип'); return false; } return true; };
  const asciiName = () => `${asciiSrc === 'text' ? 'logo' : baseName}_ascii_${stamp()}`;
  const textOut = () => lastResult.textTrimmed ?? lastResult.text;
  function renderHiRes() {
    const c = document.createElement('canvas');
    AsciiEngine.render(lastResult, c, readAsciiStyle({ scale: 2 }));
    return c;
  }
  function exportAsciiPng() { if (need()) renderHiRes().toBlob((b) => saveBlob(b, asciiName() + '.png'), 'image/png'); }
  $('exCopy').addEventListener('click', () => need() && copyText(textOut()));
  $('exPng').addEventListener('click', exportAsciiPng);
  $('exSvg').addEventListener('click', () => need() && saveText(AsciiEngine.toSVG(lastResult, readAsciiStyle()), asciiName() + '.svg', 'image/svg+xml'));
  $('exHtml').addEventListener('click', () => need() && saveText(AsciiEngine.toHTML(lastResult, readAsciiStyle()), asciiName() + '.html', 'text/html'));
  $('exTxt').addEventListener('click', () => need() && saveText(textOut(), asciiName() + '.txt'));
  $('exAnsi').addEventListener('click', () => need() && saveText(AsciiEngine.toANSI(lastResult), asciiName() + '.ans'));
  $('exToEditor').addEventListener('click', () => {
    if (!need()) return;
    baseName = asciiName();
    setImage(renderHiRes());
    showTab('editor');
  });

  // ============================================================ GIF
  const gifCanvas = $('gifCanvas');
  const gctx = gifCanvas.getContext('2d');
  const gif = {
    frames: [],          // [{ canvas, delay }], fully composited source frames
    width: 0, height: 0, hasAlpha: false, name: 'animation',
    mode: 'anim',        // 'anim' | 'ascii'
    dir: 'fwd',          // 'fwd' | 'rev' | 'pingpong'
    speed: 1,
    seq: [],             // playback order: indices into frames
    pos: 0,              // position in seq
    playing: true,
    timer: 0,
    asciiCache: new Map(),
    asciiSig: '',
    exporting: null,
  };

  const gifInput = $('gifInput');
  ['gifOpen', 'gifEmptyOpen'].forEach((id) => $(id).addEventListener('click', (e) => { e.stopPropagation(); gifInput.click(); }));
  $('gifEmpty').addEventListener('click', () => gifInput.click());
  gifInput.addEventListener('change', async () => {
    const f = gifInput.files[0];
    gifInput.value = '';
    if (f) await openGif(f, true);
  });

  /** Decodes a GIF into the GIF tab. Returns false (and leaves everything as is) for a still image,
   *  unless force is set, so the editor can open single frame GIFs as ordinary pictures. */
  async function openGif(file, force = false) {
    let data;
    try {
      data = GifCodec.decode(await file.arrayBuffer());
    } catch (err) {
      console.warn(err);
      if (force) toast('Не удалось прочитать GIF');
      return false;
    }
    if (data.frames.length < 2 && !force) return false;

    clearTimeout(gif.timer);
    gif.width = data.width;
    gif.height = data.height;
    gif.frames = data.frames.map((f) => {
      const c = document.createElement('canvas');
      c.width = data.width;
      c.height = data.height;
      c.getContext('2d').putImageData(f.imageData, 0, 0);
      return { canvas: c, delay: f.delay };
    });
    const a = data.frames[0].imageData.data;
    gif.hasAlpha = false;
    for (let i = 3; i < a.length; i += 4) if (a[i] < 128) { gif.hasAlpha = true; break; }
    gif.name = (file.name || 'animation').replace(/\.[^.]+$/, '') || 'animation';
    gif.asciiCache.clear();
    gif.asciiSig = '';
    gif.pos = 0;
    gif.playing = true;
    if (data.loopCount !== null && data.loopCount !== undefined) $('gifLoop').checked = data.loopCount === 0;

    const n = gif.frames.length;
    ['gifTrimA', 'gifTrimB'].forEach((id) => { $(id).max = n; });
    $('gifTrimA').value = 1; $('gifTrimAV').textContent = 1;
    $('gifTrimB').value = n; $('gifTrimBV').textContent = n;
    const w = $('gifWidth');
    w.min = Math.min(32, gif.width);
    w.max = Math.max(gif.width, 64);
    w.value = Math.min(gif.width, 640);
    $('gifWidthV').textContent = w.value + ' px';

    const total = gif.frames.reduce((s, f) => s + f.delay, 0);
    $('gifSrcInfo').textContent = `${gif.name}.gif, ${gif.width} × ${gif.height}, кадров: ${n}, ${(total / 1000).toFixed(1)} с` +
      (data.truncated ? '. Файл очень большой, загружена только часть кадров.' : '');
    $('gifEmpty').hidden = true;
    gifCanvas.hidden = false;

    if (!ed.hasImage()) { baseName = gif.name; setImage(gif.frames[0].canvas); }
    gifRebuildSeq();
    showTab('gif');
    return true;
  }

  function gifRebuildSeq() {
    const n = gif.frames.length;
    if (!n) { gif.seq = []; return; }
    const a = +$('gifTrimA').value - 1, b = +$('gifTrimB').value - 1;
    const fwd = [];
    for (let i = a; i <= b; i++) fwd.push(i);
    gif.seq = gif.dir === 'rev' ? fwd.slice().reverse()
      : gif.dir === 'pingpong' ? fwd.concat(fwd.slice(1, -1).reverse())
      : fwd;
    gif.pos = Math.min(gif.pos, gif.seq.length - 1);
    const sc = $('gifScrub');
    sc.max = gif.seq.length - 1;
    sc.value = gif.pos;
  }

  /** ASCII version of a source frame; cached until any ASCII setting changes. */
  function gifAsciiFrame(idx) {
    const cols = +$('gifCols').value, font = +$('gifFont').value;
    const opts = Object.assign(readAsciiOpts(), { width: cols });
    const style = readAsciiStyle({ fontSize: font });
    const sig = JSON.stringify([opts, style]);
    if (sig !== gif.asciiSig) { gif.asciiCache.clear(); gif.asciiSig = sig; }
    let hit = gif.asciiCache.get(idx);
    if (!hit) {
      const res = AsciiEngine.convert(gif.frames[idx].canvas, opts);
      const c = document.createElement('canvas');
      AsciiEngine.render(res, c, style);
      hit = { canvas: c, res };
      gif.asciiCache.set(idx, hit);
    }
    return hit;
  }

  /** Output size of the animation mode. */
  function gifAnimSize() {
    const w = Math.max(1, +$('gifWidth').value);
    return [w, Math.max(1, Math.round(gif.height * w / gif.width))];
  }

  /** A fresh canvas with the final look of one frame (used for export). */
  function gifRenderFrame(idx) {
    if (gif.mode === 'ascii') return gifAsciiFrame(idx).canvas;
    const [w, h] = gifAnimSize();
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(gif.frames[idx].canvas, 0, 0, w, h);
    return c;
  }

  function gifDraw() {
    if (!gif.seq.length) return;
    const idx = gif.seq[gif.pos];
    let src, w, h;
    if (gif.mode === 'ascii') {
      src = gifAsciiFrame(idx).canvas;
      w = src.width; h = src.height;
    } else {
      src = gif.frames[idx].canvas;
      [w, h] = gifAnimSize();
    }
    if (gifCanvas.width !== w || gifCanvas.height !== h) { gifCanvas.width = w; gifCanvas.height = h; }
    gctx.clearRect(0, 0, w, h);
    gctx.imageSmoothingQuality = 'high';
    gctx.drawImage(src, 0, 0, w, h);
    $('gifCounter').textContent = `${idx + 1} / ${gif.frames.length}`;
    $('gifScrub').value = gif.pos;
    const dur = gif.seq.reduce((s, i) => s + gif.frames[i].delay, 0) / gif.speed;
    $('gifOutInfo').textContent = `${w} × ${h} px, кадров: ${gif.seq.length}, ${(dur / 1000).toFixed(1)} с`;
  }

  function gifPlayIcon() {
    $('gifPlay').querySelector('use').setAttribute('href', gif.playing ? '#i-pause' : '#i-play');
  }

  function gifSchedule() {
    clearTimeout(gif.timer);
    gifPlayIcon();
    if (!gif.playing || currentTab !== 'gif' || gif.seq.length < 2) return;
    const delay = gif.frames[gif.seq[gif.pos]].delay / gif.speed;
    gif.timer = setTimeout(() => {
      if (currentTab !== 'gif') return;
      if (gif.pos >= gif.seq.length - 1 && !$('gifLoop').checked) { gif.playing = false; gifPlayIcon(); return; }
      gif.pos = (gif.pos + 1) % gif.seq.length;
      gifDraw();
      gifSchedule();
    }, Math.max(10, delay));
  }

  function gifOnShow() {
    if (!gif.frames.length) return;
    gifDraw();
    gifSchedule();
  }
  /** Redraw after a settings change (also called by the shared ASCII style chips). */
  function gifRefresh() {
    if (currentTab === 'gif' && gif.frames.length) gifDraw();
  }
  function gifTogglePlay() {
    if (!gif.frames.length) return;
    if (!gif.playing && gif.pos >= gif.seq.length - 1) gif.pos = 0;
    gif.playing = !gif.playing;
    gifDraw();
    gifSchedule();
  }
  function gifStep(d) {
    if (!gif.seq.length) return;
    gif.playing = false;
    gif.pos = (gif.pos + d + gif.seq.length) % gif.seq.length;
    gifDraw();
    gifSchedule();
  }
  $('gifPlay').addEventListener('click', gifTogglePlay);
  $('gifPrev').addEventListener('click', () => gifStep(-1));
  $('gifNext').addEventListener('click', () => gifStep(1));
  $('gifScrub').addEventListener('input', (e) => {
    if (!gif.seq.length) return;
    gif.playing = false;
    gif.pos = +e.target.value;
    gifDraw();
    gifSchedule();
  });

  seg('gifMode', (b) => {
    gif.mode = b.dataset.v;
    const ascii = gif.mode === 'ascii';
    $('gifAnimPane').hidden = ascii;
    $('gifAsciiPane').hidden = !ascii;
    $('gifExTxt').hidden = !ascii;
    gifRefresh();
  });
  seg('gifDir', (b) => { gif.dir = b.dataset.v; gifRebuildSeq(); gifRefresh(); gifSchedule(); });
  bindRange('gifSpeed', (v) => { gif.speed = v / 100; gifRefresh(); gifSchedule(); }, (v) => (v / 100).toFixed(2) + 'x');
  bindRange('gifTrimA', (v) => {
    if (v > +$('gifTrimB').value) { $('gifTrimB').value = v; $('gifTrimBV').textContent = v; }
    gifRebuildSeq(); gifRefresh();
  });
  bindRange('gifTrimB', (v) => {
    if (v < +$('gifTrimA').value) { $('gifTrimA').value = v; $('gifTrimAV').textContent = v; }
    gifRebuildSeq(); gifRefresh();
  });
  bindRange('gifWidth', gifRefresh, (v) => v + ' px');
  bindRange('gifColors', () => {});
  bindRange('gifCols', gifRefresh);
  bindRange('gifFont', gifRefresh);
  $('gifLoop').addEventListener('input', gifSchedule);

  async function gifExport() {
    if (!gif.frames.length) { toast('Сначала откройте GIF'); return; }
    if (gif.exporting) { gif.exporting.abort(); return; }
    const ac = new AbortController();
    gif.exporting = ac;
    const btn = $('gifExport'), label = btn.querySelector('span'), bar = $('gifProgress'), fill = bar.querySelector('i');
    btn.classList.add('busy');
    label.textContent = 'Отменить';
    bar.hidden = false;
    fill.style.width = '0%';
    try {
      const ascii = gif.mode === 'ascii';
      const frames = [];
      for (let i = 0; i < gif.seq.length; i++) {
        if (ac.signal.aborted) throw new DOMException('aborted', 'AbortError');
        const idx = gif.seq[i];
        frames.push({ image: gifRenderFrame(idx), delay: gif.frames[idx].delay / gif.speed });
        fill.style.width = ((i + 1) / gif.seq.length) * 40 + '%';
        if (i % 3 === 2) await new Promise((r) => setTimeout(r, 0));
      }
      const style = readAsciiStyle();
      const blob = await GifCodec.encode(frames, {
        loop: $('gifLoop').checked ? 0 : -1,
        colors: ascii ? 256 : +$('gifColors').value,
        dither: !ascii && $('gifDither').checked,
        globalPalette: ascii && style.colorMode !== 'original',
        transparent: ascii ? style.transparentBg : gif.hasAlpha,
        optimize: true,
        signal: ac.signal,
        onProgress: (f) => { fill.style.width = 40 + f * 60 + '%'; },
      });
      await saveBlob(blob, `${gif.name}_${ascii ? 'ascii' : 'edit'}.gif`);
    } catch (err) {
      if (err && err.name === 'AbortError') toast('Сохранение отменено');
      else { console.error(err); toast('Не удалось сохранить GIF'); }
    } finally {
      gif.exporting = null;
      btn.classList.remove('busy');
      label.textContent = 'Сохранить GIF';
      bar.hidden = true;
    }
  }
  $('gifExport').addEventListener('click', gifExport);
  $('gifExPng').addEventListener('click', () => {
    if (!gif.frames.length) return;
    gifCanvas.toBlob((b) => saveBlob(b, `${gif.name}_frame${gif.seq[gif.pos] + 1}.png`), 'image/png');
  });
  $('gifExTxt').addEventListener('click', () => {
    if (!gif.frames.length) return;
    const text = gif.seq.map((idx) => gifAsciiFrame(idx).res.textTrimmed ?? gifAsciiFrame(idx).res.text).join('\n\n\n');
    saveText(text, `${gif.name}_ascii.txt`);
  });
  $('gifToEditor').addEventListener('click', () => {
    if (!gif.frames.length) return;
    const c = document.createElement('canvas');
    c.width = gifCanvas.width;
    c.height = gifCanvas.height;
    c.getContext('2d').drawImage(gifCanvas, 0, 0);
    baseName = `${gif.name}_frame${gif.seq[gif.pos] + 1}`;
    setImage(c);
    showTab('editor');
  });

  drawCurve();
  updateUI();
})();
