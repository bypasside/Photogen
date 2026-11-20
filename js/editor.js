/*
 * Photogen - PhotoEditor engine
 * Dependency-free browser photo editing engine (plain ES2020, classic script).
 * Exposes window.PhotoEditor.
 *
 * Architecture:
 *   base canvas   - destructive ops (rotate / flip / crop / resize) replace it with a new canvas
 *   paint canvas  - brush / eraser / text / shapes, same size as base, transformed along with base
 *   params        - non-destructive adjustments + master RGB curve + one preset filter
 * Render: base -> (blur, sharpen, per-pixel colour pass) -> paint layer -> visible canvas -> overlays.
 * Every history entry carries a short (Russian) label for the history panel.
 * History snapshots share canvas references (base canvases are never mutated in place; the
 * paint layer is copied on write), so slider-only history entries cost almost no memory.
 */
(function () {
  'use strict';

  const MAX_SIDE = 4096;            // longest side allowed on load
  const MAX_RESIZE_SIDE = 8192;     // longest side allowed via resize()
  const MAX_HISTORY = 30;
  const PREVIEW_THRESHOLD = 2000000; // images above this many pixels get a downscaled live preview
  const PREVIEW_PIXELS = 1200000;    // target pixel count of the preview
  const PREVIEW_IDLE_MS = 300;       // full-res re-render after this much idle time

  const ADJUSTMENTS = {
    brightness:  { min: -100, max: 100, default: 0 },
    contrast:    { min: -100, max: 100, default: 0 },
    saturation:  { min: -100, max: 100, default: 0 },
    exposure:    { min: -100, max: 100, default: 0 },
    hue:         { min: -180, max: 180, default: 0 },
    temperature: { min: -100, max: 100, default: 0 },
    tint:        { min: -100, max: 100, default: 0 },
    highlights:  { min: -100, max: 100, default: 0 },
    shadows:     { min: -100, max: 100, default: 0 },
    blur:        { min: 0,    max: 20,  default: 0 },
    sharpen:     { min: 0,    max: 100, default: 0 },
    vignette:    { min: 0,    max: 100, default: 0 },
    noise:       { min: 0,    max: 100, default: 0 }
  };
  const FILTERS = ['none', 'grayscale', 'sepia', 'vintage', 'cold', 'warm', 'invert',
    'noir', 'dramatic', 'pop', 'fade', 'cyber'];
  const TOOLS = ['none', 'crop', 'brush', 'eraser', 'text', 'eyedropper', 'shape'];
  const SHAPES = ['rect', 'ellipse', 'line', 'arrow'];

  const FILTER_LABELS = {
    none: 'Оригинал', grayscale: 'Ч/Б', sepia: 'Сепия', vintage: 'Винтаж', warm: 'Тёплый',
    cold: 'Холодный', noir: 'Нуар', dramatic: 'Драма', pop: 'Поп', fade: 'Выцветший',
    cyber: 'Кибер', invert: 'Негатив'
  };

  /* ---------- small helpers ---------- */

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  function toHex(r, g, b) {
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  function sameAdjustments(a, b) {
    for (const k in ADJUSTMENTS) if (a[k] !== b[k]) return false;
    return true;
  }

  /* ---------- tone curve ---------- */

  const defaultCurve = () => [[0, 0], [255, 255]];

  // Sanitise user points: finite, clamped to 0..255, sorted by x, unique x. Returns null if < 2 points.
  function normalizeCurve(points) {
    if (!Array.isArray(points)) return null;
    const pts = [];
    for (const p of points) {
      if (!p) continue;
      const x = Number(Array.isArray(p) ? p[0] : p.x), y = Number(Array.isArray(p) ? p[1] : p.y);
      if (!isFinite(x) || !isFinite(y)) continue;
      pts.push([clamp(x, 0, 255), clamp(y, 0, 255)]);
    }
    pts.sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const p of pts) {
      if (out.length && out[out.length - 1][0] === p[0]) out[out.length - 1] = p; // duplicate x: keep last
      else out.push(p);
    }
    return out.length >= 2 ? out : null;
  }

  // 256-entry LUT using monotone cubic (Fritsch-Carlson) interpolation; flat outside the end points.
  function buildCurveLut(pts) {
    const n = pts.length;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const d = new Array(n - 1), m = new Array(n);
    for (let k = 0; k < n - 1; k++) d[k] = (ys[k + 1] - ys[k]) / (xs[k + 1] - xs[k]);
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let k = 1; k < n - 1; k++) m[k] = d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2;
    for (let k = 0; k < n - 1; k++) {
      if (d[k] === 0) { m[k] = 0; m[k + 1] = 0; continue; }
      const a = m[k] / d[k], b = m[k + 1] / d[k], s = a * a + b * b;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        m[k] = t * a * d[k];
        m[k + 1] = t * b * d[k];
      }
    }
    const lut = new Uint8ClampedArray(256);
    let k = 0;
    for (let i = 0; i < 256; i++) {
      let y;
      if (i <= xs[0]) y = ys[0];
      else if (i >= xs[n - 1]) y = ys[n - 1];
      else {
        while (k < n - 2 && i >= xs[k + 1]) k++;
        const h = xs[k + 1] - xs[k], t = (i - xs[k]) / h, t2 = t * t, t3 = t2 * t;
        y = (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k] +
          (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1];
      }
      lut[i] = y; // clamps + rounds
    }
    return lut;
  }

  function isIdentityLut(lut) {
    for (let i = 0; i < 256; i++) if (lut[i] !== i) return false;
    return true;
  }

  /* ---------- shapes ---------- */

  // End points of a shape drag, with Shift constraints applied.
  function shapeGeometry(s) {
    const x0 = s.start.x, y0 = s.start.y;
    let x1 = s.end.x, y1 = s.end.y;
    if (s.shift) {
      const dx = x1 - x0, dy = y1 - y0;
      if (s.type === 'rect' || s.type === 'ellipse') {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        x1 = x0 + (dx < 0 ? -m : m);
        y1 = y0 + (dy < 0 ? -m : m);
      } else {
        const step = Math.PI / 4;
        const ang = Math.round(Math.atan2(dy, dx) / step) * step, len = Math.hypot(dx, dy);
        x1 = x0 + Math.cos(ang) * len;
        y1 = y0 + Math.sin(ang) * len;
      }
    }
    return { x0, y0, x1, y1 };
  }

  // s: { type, color, size (image px), fill, opacity, start, end, shift }
  function drawShape(ctx, s) {
    const g = shapeGeometry(s);
    ctx.save();
    ctx.globalAlpha = s.opacity;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = s.color;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.size;
    ctx.beginPath();
    if (s.type === 'rect' || s.type === 'ellipse') {
      const x = Math.min(g.x0, g.x1), y = Math.min(g.y0, g.y1);
      const w = Math.abs(g.x1 - g.x0), h = Math.abs(g.y1 - g.y0);
      if (s.type === 'rect') {
        ctx.lineJoin = 'miter';
        ctx.rect(x, y, w, h);
      } else {
        ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      }
      if (s.fill) ctx.fill(); else ctx.stroke();
    } else if (s.type === 'line') {
      ctx.lineCap = 'round';
      ctx.moveTo(g.x0, g.y0);
      ctx.lineTo(g.x1, g.y1);
      ctx.stroke();
    } else {
      // Arrow: one polygon (shaft + head) so semi-transparent arrows have no overlap seams.
      const dx = g.x1 - g.x0, dy = g.y1 - g.y0, len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len, px = -uy, py = ux;
      const head = Math.min(len, Math.max(6, s.size * 4));
      const hw = s.size / 2, hh = Math.max(hw, head * 0.55);
      const bx = g.x1 - ux * head, by = g.y1 - uy * head;
      ctx.moveTo(g.x0 + px * hw, g.y0 + py * hw);
      ctx.lineTo(bx + px * hw, by + py * hw);
      ctx.lineTo(bx + px * hh, by + py * hh);
      ctx.lineTo(g.x1, g.y1);
      ctx.lineTo(bx - px * hh, by - py * hh);
      ctx.lineTo(bx - px * hw, by - py * hw);
      ctx.lineTo(g.x0 - px * hw, g.y0 - py * hw);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function createCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  function cloneCanvas(src) {
    const c = createCanvas(src.width, src.height);
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  function sourceSize(src) {
    return {
      w: src.naturalWidth || src.videoWidth || src.width || 0,
      h: src.naturalHeight || src.videoHeight || src.height || 0
    };
  }

  function smoothCtx(ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return ctx;
  }

  // High-quality resample into a new canvas; downscales in halving steps to avoid aliasing.
  function resample(src, sw, sh, dw, dh) {
    dw = Math.max(1, Math.round(dw));
    dh = Math.max(1, Math.round(dh));
    let cur = src, cw = sw, ch = sh;
    while (cw * 0.5 > dw || ch * 0.5 > dh) {
      const nw = Math.max(dw, Math.round(cw * 0.5));
      const nh = Math.max(dh, Math.round(ch * 0.5));
      const step = createCanvas(nw, nh);
      smoothCtx(step.getContext('2d')).drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
      cur = step; cw = nw; ch = nh;
    }
    const out = createCanvas(dw, dh);
    smoothCtx(out.getContext('2d')).drawImage(cur, 0, 0, cw, ch, 0, 0, dw, dh);
    return out;
  }

  // Stable numeric ids for canvases (used in render cache keys).
  const canvasIds = new WeakMap();
  let nextId = 1;
  function idOf(c) {
    let id = canvasIds.get(c);
    if (!id) { id = nextId++; canvasIds.set(c, id); }
    return id;
  }

  let ctxFilterSupport = null;
  function supportsCtxFilter() {
    if (ctxFilterSupport === null) {
      try {
        const x = createCanvas(1, 1).getContext('2d');
        ctxFilterSupport = typeof x.filter === 'string';
      } catch (_) { ctxFilterSupport = false; }
    }
    return ctxFilterSupport;
  }

  /* ---------- colour matrices (3x3, row-major) ---------- */

  const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const SEPIA = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131];

  function satMatrix(s) {
    return [
      0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
      0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
      0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s
    ];
  }

  function hueMatrix(deg) {
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return [
      0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
      0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
      0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072
    ];
  }

  // a * b  (b is applied first)
  function mulMat(a, b) {
    const o = new Array(9);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
      }
    }
    return o;
  }

  function mixMat(a, b, t) {
    return a.map((v, i) => v + (b[i] - v) * t);
  }

  function sCurve(v, k) {
    const t = v / 255;
    const s = t < 0.5 ? 0.5 * Math.pow(2 * t, k) : 1 - 0.5 * Math.pow(2 * (1 - t), k);
    return s * 255;
  }

  /* ---------- filter presets ---------- */

  // Each preset: optional matrix, optional per-channel curves (1 fn = all channels, or [r,g,b]),
  // optional split toning offsets for shadows / highlights.
  const FILTER_DEFS = {
    grayscale: { matrix: satMatrix(0) },
    sepia: { matrix: SEPIA },
    vintage: {
      matrix: mulMat(mixMat(IDENTITY, SEPIA, 0.45), satMatrix(0.85)),
      curves: [v => (22 + v * 0.86) * 1.04, v => 22 + v * 0.86, v => (22 + v * 0.86) * 0.9 + 6]
    },
    cold: { matrix: satMatrix(0.9), curves: [v => v * 0.92, v => v * 0.98 + 3, v => v * 1.05 + 14] },
    warm: { matrix: satMatrix(1.08), curves: [v => v * 1.06 + 10, v => v * 1.01 + 4, v => v * 0.88] },
    invert: { curves: [v => 255 - v] },
    noir: { matrix: satMatrix(0), curves: [v => sCurve(v, 1.9) * 0.97] },
    dramatic: { matrix: satMatrix(0.65), curves: [v => (v - 128) * 1.35 + 120] },
    pop: { matrix: satMatrix(1.55), curves: [v => (v - 128) * 1.15 + 130] },
    fade: { matrix: satMatrix(0.7), curves: [v => 40 + v * 0.76] },
    cyber: {
      matrix: satMatrix(1.2),
      curves: [v => (v - 128) * 1.18 + 128],
      split: { shadow: [-30, 22, 48], highlight: [48, -22, 36] } // teal shadows, magenta highlights
    }
  };

  const compiledFilters = {};
  function getFilterDef(name) {
    if (!name || name === 'none' || !FILTER_DEFS[name]) return null;
    if (compiledFilters[name]) return compiledFilters[name];
    const def = FILTER_DEFS[name];
    let curves = null;
    if (def.curves) {
      const build = fn => {
        const l = new Uint8ClampedArray(256);
        for (let i = 0; i < 256; i++) l[i] = fn(i);
        return l;
      };
      const ls = def.curves.map(build);
      curves = ls.length === 1 ? [ls[0], ls[0], ls[0]] : ls;
    }
    compiledFilters[name] = { matrix: def.matrix || null, curves, split: def.split || null };
    return compiledFilters[name];
  }

  /* ---------- pixel kernels ---------- */

  function sharpenData(d, w, h, amount) {
    if (w < 3 || h < 3 || amount <= 0) return;
    const src = new Uint8ClampedArray(d);
    const c = 1 + 4 * amount, row = w * 4;
    for (let y = 1; y < h - 1; y++) {
      let i = (y * w + 1) * 4;
      for (let x = 1; x < w - 1; x++, i += 4) {
        for (let k = i; k < i + 3; k++) {
          d[k] = c * src[k] - amount * (src[k - 4] + src[k + 4] + src[k - row] + src[k + row]);
        }
      }
    }
  }

  // Fallback blur (3-pass box blur ~ gaussian) for browsers without ctx.filter.
  function boxBlur(d, w, h, sigma) {
    const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
    const tmp = new Uint8ClampedArray(d.length);
    for (let p = 0; p < 3; p++) {
      blurPass(d, tmp, w, h, r, 4, w * 4, w, h);   // horizontal
      blurPass(tmp, d, w, h, r, w * 4, 4, h, w);   // vertical
    }
  }

  // Generic 1D running-sum blur. step = stride along the blur axis, lineStride = stride between lines.
  function blurPass(s, t, w, h, r, step, lineStride, len, lines) {
    const inv = 1 / (2 * r + 1), last = len - 1;
    for (let ln = 0; ln < lines; ln++) {
      const base = ln * lineStride;
      for (let c = 0; c < 4; c++) {
        const o = base + c;
        let acc = 0;
        for (let j = -r; j <= r; j++) acc += s[o + clamp(j, 0, last) * step];
        for (let p = 0; p < len; p++) {
          t[o + p * step] = acc * inv;
          const add = p + r + 1, rem = p - r;
          acc += s[o + (add > last ? last : add) * step] - s[o + (rem < 0 ? 0 : rem) * step];
        }
      }
    }
  }

  const HANDLE_CURSORS = {
    nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', inside: 'move'
  };

  /* ================================================================== */

  class PhotoEditor {
    constructor(canvas) {
      if (!canvas || !canvas.getContext) throw new Error('PhotoEditor: a <canvas> element is required');
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');

      this.base = null;
      this.paint = null;
      this._paintShared = false;   // paint canvas referenced by a history snapshot -> copy before drawing

      this._adj = PhotoEditor._defaultAdjustments();
      this._filter = 'none';
      this._tool = 'none';
      this._brush = { color: '#ff3b30', size: 12, opacity: 1 };
      this._text = { text: 'Text', font: 'Inter, Arial, sans-serif', size: 48, color: '#ffffff', bold: false };
      this._shape = { type: 'rect', color: '#ffffff', size: 4, fill: false, opacity: 1 };
      this._cropRatio = null;
      this._crop = null;
      this._compare = false;
      this._setCurveState(defaultCurve());

      this._history = [];
      this._index = -1;
      this._listeners = new Set();
      this._pickListeners = new Set();

      this._raf = 0;
      this._previewing = false;
      this._previewTimer = 0;
      this._cache = { full: null, preview: null };    // {key, canvas}
      this._work = { full: null, preview: null };     // reusable work canvases
      this._previewBase = null;                       // {key, canvas}

      this._pointerId = null;
      this._stroke = null;
      this._drag = null;
      this._hover = null;
      this._strokeCanvas = null;
      this._scratch = null;
      this._shapeDrag = null;      // in-progress shape: { type, color, size, fill, opacity, start, end, shift }
      this._picking = false;       // eyedropper drag in progress
      this._lastPick = null;
      this._pickCtx = null;

      this._onDown = this._onPointerDown.bind(this);
      this._onMove = this._onPointerMove.bind(this);
      this._onUp = this._onPointerUp.bind(this);
      this._onLeave = this._onPointerLeave.bind(this);
      canvas.addEventListener('pointerdown', this._onDown);
      canvas.addEventListener('pointermove', this._onMove);
      canvas.addEventListener('pointerup', this._onUp);
      canvas.addEventListener('pointercancel', this._onUp);
      canvas.addEventListener('pointerleave', this._onLeave);
      // Shift pressed / released mid-drag (without moving) updates the shape constraint.
      this._onKey = e => {
        if (e.key !== 'Shift' || !this._shapeDrag) return;
        this._shapeDrag.shift = e.type === 'keydown';
        this._requestRender();
      };
      window.addEventListener('keydown', this._onKey);
      window.addEventListener('keyup', this._onKey);

      // Overlay line widths depend on on-screen scale; redraw when the canvas is resized by CSS.
      if (typeof ResizeObserver === 'function') {
        this._ro = new ResizeObserver(() => {
          if (this.base && this._tool !== 'none') this._requestRender();
        });
        this._ro.observe(canvas);
      }
      this._updateCursor();
    }

    static _defaultAdjustments() {
      const o = {};
      for (const k in ADJUSTMENTS) o[k] = ADJUSTMENTS[k].default;
      return o;
    }

    /* ---------------- image ---------------- */

    loadImage(src) {
      const { w, h } = sourceSize(src || {});
      if (!w || !h) throw new Error('PhotoEditor.loadImage: source has no size (not loaded yet?)');
      let tw = w, th = h;
      const m = Math.max(w, h);
      if (m > MAX_SIDE) {
        const s = MAX_SIDE / m;
        tw = Math.max(1, Math.round(w * s));
        th = Math.max(1, Math.round(h * s));
      }
      this._cancelInteraction();
      this.base = resample(src, w, h, tw, th);
      this.paint = createCanvas(this.base.width, this.base.height);
      this._paintShared = false;
      this._adj = PhotoEditor._defaultAdjustments();
      this._setCurveState(defaultCurve());
      this._filter = 'none';
      this._previewing = false;
      this._cache = { full: null, preview: null };
      this._previewBase = null;
      this._history = [];
      this._index = -1;
      this._pushHistory('Открытие');
      if (this._tool === 'crop') this._initCrop();
      this._render();
    }

    hasImage() { return !!this.base; }

    // Extra helper: current image size in pixels.
    getSize() {
      return this.base ? { width: this.base.width, height: this.base.height } : { width: 0, height: 0 };
    }

    /* ---------------- adjustments & filters ---------------- */

    setAdjustment(name, value) {
      if (name === 'grain') name = 'noise';
      const spec = ADJUSTMENTS[name];
      if (!spec) return;
      const v = clamp(Number(value) || 0, spec.min, spec.max);
      if (this._adj[name] === v) return;
      this._adj[name] = v;
      this._livePreview();
    }

    // Live preview: use a downscaled copy for large images, then refine after idle.
    _livePreview() {
      this._previewing = true;
      clearTimeout(this._previewTimer);
      this._previewTimer = setTimeout(() => {
        this._previewing = false;
        this._requestRender();
      }, PREVIEW_IDLE_MS);
      this._requestRender();
    }

    commit() {
      if (!this.base) return;
      this._endPreview();
      if (!this._sameAsCurrent()) {
        const s = this._history[this._index];
        const curveOnly = s && s.curveKey !== this._curveKey && s.filter === this._filter &&
          sameAdjustments(s.adjustments, this._adj);
        this._pushHistory(curveOnly ? 'Кривые' : 'Коррекция');
      }
      this._requestRender();
    }

    getAdjustments() { return Object.assign({}, this._adj); }

    resetAdjustments() {
      this._adj = PhotoEditor._defaultAdjustments();
      this._setCurveState(defaultCurve());
      this._endPreview();
      if (this.base && !this._sameAsCurrent()) this._pushHistory('Сброс коррекции');
      this._requestRender();
    }

    /* ---------------- curves ---------------- */

    // points: [[x, y], ...] in 0..255. Live preview; history entry only on commit().
    setCurve(points) {
      const pts = normalizeCurve(points);
      if (!pts) return;
      if (JSON.stringify(pts) === this._curveKey) return;
      this._setCurveState(pts);
      this._livePreview();
    }

    getCurve() { return this._curve.map(p => [p[0], p[1]]); }

    // The points array is never mutated after this, so snapshots can share it.
    _setCurveState(pts) {
      this._curve = pts;
      this._curveKey = JSON.stringify(pts);
      const lut = buildCurveLut(pts);
      this._curveLut = isIdentityLut(lut) ? null : lut;
    }

    applyFilter(name) {
      if (!name) name = 'none';
      if (FILTERS.indexOf(name) === -1) return;
      this._filter = name;
      this._endPreview();
      if (this.base && !this._sameAsCurrent()) this._pushHistory('Фильтр: ' + (FILTER_LABELS[name] || name));
      this._requestRender();
    }

    getFilter() { return this._filter; }

    /* ---------------- destructive transforms ---------------- */

    rotate(deg) {
      if (!this.base) return;
      const d = (((Math.round((Number(deg) || 0) / 90) * 90) % 360) + 360) % 360;
      if (!d) return;
      this._transform(src => {
        const sw = src.width, sh = src.height;
        const swap = d !== 180;
        const c = createCanvas(swap ? sh : sw, swap ? sw : sh);
        const x = c.getContext('2d');
        if (d === 90) x.setTransform(0, 1, -1, 0, sh, 0);        // clockwise
        else if (d === 270) x.setTransform(0, -1, 1, 0, 0, sw);  // counter-clockwise
        else x.setTransform(-1, 0, 0, -1, sw, sh);
        x.drawImage(src, 0, 0);
        return c;
      }, 'Поворот');
    }

    flip(axis) {
      if (!this.base || (axis !== 'h' && axis !== 'v')) return;
      this._transform(src => {
        const c = createCanvas(src.width, src.height);
        const x = c.getContext('2d');
        if (axis === 'h') x.setTransform(-1, 0, 0, 1, src.width, 0);
        else x.setTransform(1, 0, 0, -1, 0, src.height);
        x.drawImage(src, 0, 0);
        return c;
      }, 'Отражение');
    }

    resize(w, h) {
      if (!this.base) return;
      w = clamp(Math.round(Number(w) || 0), 1, MAX_RESIZE_SIDE);
      h = clamp(Math.round(Number(h) || 0), 1, MAX_RESIZE_SIDE);
      if (w === this.base.width && h === this.base.height) return;
      this._transform(src => resample(src, src.width, src.height, w, h), 'Размер');
    }

    // Applies fn(canvas) -> newCanvas to both base and paint layers, then pushes history.
    _transform(fn, label) {
      this._cancelInteraction();
      this._endPreview();
      this.base = fn(this.base);
      this.paint = fn(this.paint);
      this._paintShared = false;
      this._pushHistory(label);
      if (this._tool === 'crop') this._initCrop();
      this._render();
    }

    /* ---------------- tools ---------------- */

    setTool(name) {
      if (TOOLS.indexOf(name) === -1) name = 'none';
      if (name === this._tool) return;
      this._cancelInteraction();
      this._tool = name;
      this._hover = null;
      if (name === 'crop') this._initCrop();
      else this._crop = null;
      this.canvas.style.touchAction = name === 'none' ? '' : 'none';
      this._updateCursor();
      this._requestRender();
    }

    getTool() { return this._tool; }

    setBrush(opts) {
      if (!opts) return;
      if (typeof opts.color === 'string' && opts.color) this._brush.color = opts.color;
      if (opts.size != null && isFinite(opts.size)) this._brush.size = clamp(Number(opts.size), 1, 1000);
      if (opts.opacity != null && isFinite(opts.opacity)) {
        let o = Number(opts.opacity);
        if (o > 1) o /= 100; // tolerate percentages
        this._brush.opacity = clamp(o, 0, 1);
      }
      if (this._hover) this._requestRender();
    }

    setText(opts) {
      if (!opts) return;
      if (opts.text != null) this._text.text = String(opts.text);
      if (typeof opts.font === 'string' && opts.font) this._text.font = opts.font;
      if (opts.size != null && isFinite(opts.size)) this._text.size = clamp(Number(opts.size), 1, 2000);
      if (typeof opts.color === 'string' && opts.color) this._text.color = opts.color;
      if (opts.bold != null) this._text.bold = !!opts.bold;
    }

    // opts: any subset of { type: 'rect'|'ellipse'|'line'|'arrow', color, size (screen px), fill, opacity }
    setShape(opts) {
      if (!opts) return;
      if (SHAPES.indexOf(opts.type) !== -1) this._shape.type = opts.type;
      if (typeof opts.color === 'string' && opts.color) this._shape.color = opts.color;
      if (opts.size != null && isFinite(opts.size)) this._shape.size = clamp(Number(opts.size), 1, 1000);
      if (opts.fill != null) this._shape.fill = !!opts.fill;
      if (opts.opacity != null && isFinite(opts.opacity)) {
        let o = Number(opts.opacity);
        if (o > 1) o /= 100; // tolerate percentages
        this._shape.opacity = clamp(o, 0, 1);
      }
    }

    // Extra helper: current shape settings.
    getShape() { return Object.assign({}, this._shape); }

    // Clears every brush / shape / text stroke (one history entry).
    clearPaint() {
      if (!this.base) return;
      this._cancelInteraction();
      this._endPreview();
      this.paint = createCanvas(this.base.width, this.base.height); // new canvas: snapshots keep the old one
      this._paintShared = false;
      this._pushHistory('Очистка рисунка');
      this._requestRender();
    }

    /* ---------------- eyedropper ---------------- */

    // cb(hex '#rrggbb', { r, g, b }) - called on eyedropper click / drag. Returns an unsubscribe fn.
    onPick(cb) {
      if (typeof cb !== 'function') return () => {};
      this._pickListeners.add(cb);
      return () => this._pickListeners.delete(cb);
    }

    // Samples the final composited pixel (adjustments + curve + filter + paint), full resolution.
    _pick(p) {
      const W = this.base.width, H = this.base.height;
      const x = clamp(Math.floor(p.x), 0, W - 1), y = clamp(Math.floor(p.y), 0, H - 1);
      if (!this._pickCtx) {
        this._pickCtx = createCanvas(1, 1).getContext('2d', { willReadFrequently: true });
      }
      const ctx = this._pickCtx;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, 1, 1);
      ctx.drawImage(this._getProcessed(1), x, y, 1, 1, 0, 0, 1, 1);
      ctx.drawImage(this.paint, x, y, 1, 1, 0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      const hex = toHex(d[0], d[1], d[2]);
      if (hex === this._lastPick) return;
      this._lastPick = hex;
      const rgb = { r: d[0], g: d[1], b: d[2] };
      this._pickListeners.forEach(cb => {
        try { cb(hex, Object.assign({}, rgb)); } catch (err) { console.error(err); }
      });
    }

    /* ---------------- before / after ---------------- */

    // true: visible canvas shows base + paint without adjustments / curve / filter. Export unaffected.
    setCompare(on) {
      on = !!on;
      if (on === this._compare) return;
      this._compare = on;
      this._requestRender();
    }

    getCompare() { return this._compare; }

    /* ---------------- crop ---------------- */

    setCropRatio(ratio) {
      const r = Number(ratio);
      this._cropRatio = ratio == null || !isFinite(r) || r <= 0 ? null : r;
      if (this._tool === 'crop' && this.base) {
        const c = this._crop;
        this._crop = c
          ? this._fitRatioRect(c.x + c.w / 2, c.y + c.h / 2, this._cropRatio === null ? c : null)
          : this._fitRatioRect(this.base.width / 2, this.base.height / 2);
        this._requestRender();
      }
    }

    applyCrop() {
      if (!this.base) return;
      const c = this._crop;
      this._cancelInteraction();
      this._crop = null;
      this._tool = 'none';
      this.canvas.style.touchAction = '';
      this._updateCursor();
      if (c) {
        const x = clamp(Math.round(c.x), 0, this.base.width - 1);
        const y = clamp(Math.round(c.y), 0, this.base.height - 1);
        const w = clamp(Math.round(c.w), 1, this.base.width - x);
        const h = clamp(Math.round(c.h), 1, this.base.height - y);
        if (!(x === 0 && y === 0 && w === this.base.width && h === this.base.height)) {
          this._transform(src => {
            const out = createCanvas(w, h);
            out.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h);
            return out;
          }, 'Обрезка');
          return;
        }
      }
      this._requestRender();
    }

    cancelCrop() {
      if (this._tool !== 'crop') { this._crop = null; return; }
      this.setTool('none');
    }

    _initCrop() {
      this._crop = this.base ? this._fitRatioRect(this.base.width / 2, this.base.height / 2) : null;
    }

    // Largest rect with the current ratio (or the full image / `freeRect` if free), centered near (cx, cy).
    _fitRatioRect(cx, cy, freeRect) {
      const W = this.base.width, H = this.base.height, R = this._cropRatio;
      if (!R) return freeRect ? Object.assign({}, freeRect) : { x: 0, y: 0, w: W, h: H };
      let w = W, h = W / R;
      if (h > H) { h = H; w = H * R; }
      return { x: clamp(cx - w / 2, 0, W - w), y: clamp(cy - h / 2, 0, H - h), w, h };
    }

    _cropHandles(c) {
      const mx = c.x + c.w / 2, my = c.y + c.h / 2, r = c.x + c.w, b = c.y + c.h;
      return [['nw', c.x, c.y], ['ne', r, c.y], ['se', r, b], ['sw', c.x, b],
        ['n', mx, c.y], ['e', r, my], ['s', mx, b], ['w', c.x, my]];
    }

    _hitCrop(x, y, touch) {
      const c = this._crop;
      if (!c) return null;
      const rad = (touch ? 22 : 12) * this._screenScale();
      for (const [name, hx, hy] of this._cropHandles(c)) {
        if (Math.abs(x - hx) <= rad && Math.abs(y - hy) <= rad) return name;
      }
      if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) return 'inside';
      return null;
    }

    _updateCropDrag(p) {
      const d = this._drag, W = this.base.width, H = this.base.height, s = d.rect;
      if (d.mode === 'move') {
        this._crop = {
          x: clamp(s.x + p.x - d.start.x, 0, W - s.w),
          y: clamp(s.y + p.y - d.start.y, 0, H - s.h),
          w: s.w, h: s.h
        };
        return;
      }
      const px = clamp(p.x, 0, W), py = clamp(p.y, 0, H);
      let handle = d.handle;
      if (d.mode === 'new') handle = (py < s.y ? 'n' : 's') + (px < s.x ? 'w' : 'e');
      this._crop = this._resizeRect(s, handle, px, py);
    }

    // Resize rect `s` by dragging `handle` to (px, py), respecting ratio and image bounds.
    _resizeRect(s, handle, px, py) {
      const W = this.base.width, H = this.base.height, R = this._cropRatio;
      const MIN = Math.min(W, H, Math.max(4, 16 * this._screenScale()));
      const hasN = handle.indexOf('n') !== -1, hasS = handle.indexOf('s') !== -1;
      const hasW = handle.indexOf('w') !== -1, hasE = handle.indexOf('e') !== -1;

      if (!R) {
        let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
        if (hasW) x0 = Math.min(px, x1 - MIN);
        if (hasE) x1 = Math.max(px, x0 + MIN);
        if (hasN) y0 = Math.min(py, y1 - MIN);
        if (hasS) y1 = Math.max(py, y0 + MIN);
        x0 = clamp(x0, 0, W); x1 = clamp(x1, 0, W);
        y0 = clamp(y0, 0, H); y1 = clamp(y1, 0, H);
        if (x1 - x0 < MIN) { if (x0 + MIN <= W) x1 = x0 + MIN; else x0 = x1 - MIN; }
        if (y1 - y0 < MIN) { if (y0 + MIN <= H) y1 = y0 + MIN; else y0 = y1 - MIN; }
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }

      const isCorner = (hasN || hasS) && (hasW || hasE);
      if (isCorner) {
        const ax = hasW ? s.x + s.w : s.x, ay = hasN ? s.y + s.h : s.y;
        const dx = hasE ? 1 : -1, dy = hasS ? 1 : -1;
        let w = Math.max(MIN, (px - ax) * dx), h = Math.max(MIN, (py - ay) * dy);
        if (w / h > R) h = w / R; else w = h * R;
        const maxW = dx > 0 ? W - ax : ax, maxH = dy > 0 ? H - ay : ay;
        if (w > maxW) { w = maxW; h = w / R; }
        if (h > maxH) { h = maxH; w = h * R; }
        return { x: dx > 0 ? ax : ax - w, y: dy > 0 ? ay : ay - h, w, h };
      }
      if (hasE || hasW) {
        const ax = hasW ? s.x + s.w : s.x, dx = hasE ? 1 : -1, cy = s.y + s.h / 2;
        let w = Math.max(MIN, (px - ax) * dx), h = w / R;
        const maxW = dx > 0 ? W - ax : ax, maxH = 2 * Math.min(cy, H - cy);
        if (w > maxW) { w = maxW; h = w / R; }
        if (h > maxH) { h = maxH; w = h * R; }
        return { x: dx > 0 ? ax : ax - w, y: cy - h / 2, w, h };
      }
      const ay = hasN ? s.y + s.h : s.y, dy = hasS ? 1 : -1, cx = s.x + s.w / 2;
      let h = Math.max(MIN, (py - ay) * dy), w = h * R;
      const maxH = dy > 0 ? H - ay : ay, maxW = 2 * Math.min(cx, W - cx);
      if (h > maxH) { h = maxH; w = h * R; }
      if (w > maxW) { w = maxW; h = w / R; }
      return { x: cx - w / 2, y: dy > 0 ? ay : ay - h, w, h };
    }

    /* ---------------- history ---------------- */

    undo() {
      if (!this.base) return;
      this._cancelInteraction();
      this._endPreview();
      if (!this._sameAsCurrent()) {
        // Uncommitted live changes: just discard them.
        this._restore(this._history[this._index]);
        return;
      }
      if (this._index <= 0) return;
      this._index--;
      this._restore(this._history[this._index]);
    }

    redo() {
      if (!this.base || this._index >= this._history.length - 1) return;
      this._cancelInteraction();
      this._endPreview();
      this._index++;
      this._restore(this._history[this._index]);
    }

    canUndo() { return this._index > 0 || (this._index >= 0 && !this._sameAsCurrent()); }
    canRedo() { return this._index >= 0 && this._index < this._history.length - 1; }

    // { items: [{ label }], index } - index is the current position in items.
    getHistory() {
      return { items: this._history.map(s => ({ label: s.label })), index: this._index };
    }

    // Restores entry i (like several undo/redo steps); the redo tail stays until a new action.
    jumpTo(i) {
      i = Math.round(Number(i));
      if (!this.base || !isFinite(i) || i < 0 || i >= this._history.length) return;
      this._cancelInteraction();
      this._endPreview();
      if (i === this._index && this._sameAsCurrent()) return;
      this._index = i;
      this._restore(this._history[i]);
    }

    _pushHistory(label) {
      const snap = {
        label: label || '',
        base: this.base,
        paint: this.paint,
        adjustments: Object.assign({}, this._adj),
        curve: this._curve,
        curveKey: this._curveKey,
        curveLut: this._curveLut,
        filter: this._filter
      };
      this._history.splice(this._index + 1);
      this._history.push(snap);
      while (this._history.length > MAX_HISTORY) this._history.shift();
      this._index = this._history.length - 1;
      this._paintShared = true;
    }

    _sameAsCurrent() {
      const s = this._history[this._index];
      if (!s) return false;
      if (s.base !== this.base || s.paint !== this.paint || s.filter !== this._filter) return false;
      if (s.curveKey !== this._curveKey) return false;
      for (const k in this._adj) if (s.adjustments[k] !== this._adj[k]) return false;
      return true;
    }

    _restore(snap) {
      this.base = snap.base;
      this.paint = snap.paint;
      this._paintShared = true;
      this._adj = Object.assign({}, snap.adjustments);
      this._curve = snap.curve;
      this._curveKey = snap.curveKey;
      this._curveLut = snap.curveLut;
      this._filter = snap.filter;
      if (this._tool === 'crop') this._initCrop();
      this._render();
    }

    // Copy-on-write for the paint layer.
    _ensurePaintOwned() {
      if (this._paintShared) {
        this.paint = cloneCanvas(this.paint);
        this._paintShared = false;
      }
    }

    /* ---------------- output ---------------- */

    getCanvas() { return this._composite(null); }

    toBlob(type = 'image/png', quality = 0.92) {
      return new Promise((resolve, reject) => {
        if (!this.base) { reject(new Error('PhotoEditor: no image loaded')); return; }
        // Formats without alpha get a white background instead of black.
        const bg = /jpe?g|bmp/i.test(type) ? '#ffffff' : null;
        const c = this._composite(bg);
        c.toBlob(b => (b ? resolve(b) : reject(new Error('PhotoEditor: export failed'))), type, quality);
      });
    }

    _composite(background) {
      if (!this.base) return null;
      const proc = this._getProcessed(1);
      const out = createCanvas(this.base.width, this.base.height);
      const x = out.getContext('2d');
      if (background) { x.fillStyle = background; x.fillRect(0, 0, out.width, out.height); }
      x.drawImage(proc, 0, 0);
      x.drawImage(this.paint, 0, 0);
      return out;
    }

    /* ---------------- events ---------------- */

    onChange(cb) {
      if (typeof cb !== 'function') return () => {};
      this._listeners.add(cb);
      return () => this._listeners.delete(cb);
    }

    _emit() {
      this._listeners.forEach(cb => {
        try { cb(); } catch (err) { console.error(err); }
      });
    }

    // Extra: detach listeners (not required by the UI).
    destroy() {
      const c = this.canvas;
      c.removeEventListener('pointerdown', this._onDown);
      c.removeEventListener('pointermove', this._onMove);
      c.removeEventListener('pointerup', this._onUp);
      c.removeEventListener('pointercancel', this._onUp);
      c.removeEventListener('pointerleave', this._onLeave);
      window.removeEventListener('keydown', this._onKey);
      window.removeEventListener('keyup', this._onKey);
      if (this._ro) this._ro.disconnect();
      if (this._raf) cancelAnimationFrame(this._raf);
      clearTimeout(this._previewTimer);
      this._listeners.clear();
      this._pickListeners.clear();
    }

    /* ---------------- rendering ---------------- */

    _requestRender() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        this._render();
      });
    }

    _endPreview() {
      clearTimeout(this._previewTimer);
      this._previewing = false;
    }

    _render() {
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
      if (!this.base) { this._emit(); return; }
      const c = this.canvas, ctx = this.ctx;
      const W = this.base.width, H = this.base.height;
      if (c.width !== W) c.width = W;
      if (c.height !== H) c.height = H;

      const px = W * H;
      const scale = this._previewing && px > PREVIEW_THRESHOLD ? Math.sqrt(PREVIEW_PIXELS / px) : 1;
      // Compare mode shows the untouched base (no adjustments / curve / filter).
      const proc = this._compare ? this.base : this._getProcessed(scale);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      smoothCtx(ctx);
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(proc, 0, 0, W, H);
      this._drawPaintLayer(ctx);
      if (this._shapeDrag) drawShape(ctx, this._shapeDrag);

      if (this._tool === 'crop' && this._crop) {
        if (!this._compare) this._drawCropOverlay(ctx);
      } else if ((this._tool === 'brush' || this._tool === 'eraser') && this._hover) {
        this._drawBrushCursor(ctx);
      }

      this._emit();
    }

    _drawPaintLayer(ctx) {
      const s = this._stroke;
      if (!s) { ctx.drawImage(this.paint, 0, 0); return; }
      if (s.mode === 'brush') {
        ctx.drawImage(this.paint, 0, 0);
        ctx.globalAlpha = s.opacity;
        ctx.drawImage(this._strokeCanvas, 0, 0);
        ctx.globalAlpha = 1;
        return;
      }
      // Eraser preview: paint minus the in-progress stroke.
      const W = this.paint.width, H = this.paint.height;
      if (!this._scratch || this._scratch.width !== W || this._scratch.height !== H) this._scratch = createCanvas(W, H);
      const x = this._scratch.getContext('2d');
      x.globalCompositeOperation = 'source-over';
      x.globalAlpha = 1;
      x.clearRect(0, 0, W, H);
      x.drawImage(this.paint, 0, 0);
      x.globalCompositeOperation = 'destination-out';
      x.globalAlpha = s.opacity;
      x.drawImage(this._strokeCanvas, 0, 0);
      x.globalCompositeOperation = 'source-over';
      x.globalAlpha = 1;
      ctx.drawImage(this._scratch, 0, 0);
    }

    _drawCropOverlay(ctx) {
      const c = this._crop, W = this.base.width, H = this.base.height, k = this._screenScale();
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.rect(c.x, c.y, c.w, c.h);
      ctx.fill('evenodd');

      // Rule-of-thirds guides
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = k;
      ctx.beginPath();
      for (let i = 1; i < 3; i++) {
        const gx = c.x + c.w * i / 3, gy = c.y + c.h * i / 3;
        ctx.moveTo(gx, c.y); ctx.lineTo(gx, c.y + c.h);
        ctx.moveTo(c.x, gy); ctx.lineTo(c.x + c.w, gy);
      }
      ctx.stroke();

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5 * k;
      ctx.strokeRect(c.x, c.y, c.w, c.h);

      const hs = 10 * k;
      ctx.lineWidth = k;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.fillStyle = '#ffffff';
      for (const [, hx, hy] of this._cropHandles(c)) {
        ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
        ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
      }
      ctx.restore();
    }

    _drawBrushCursor(ctx) {
      const k = this._screenScale();
      const r = Math.max(1, this._brush.size * k / 2);
      const p = this._hover;
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.lineWidth = 2.5 * k;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.stroke();
      ctx.lineWidth = 1 * k;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.stroke();
      ctx.restore();
    }

    _needsColorPass() {
      const a = this._adj;
      return this._filter !== 'none' || this._curveLut !== null || a.brightness !== 0 || a.contrast !== 0 || a.saturation !== 0 ||
        a.exposure !== 0 || a.hue !== 0 || a.temperature !== 0 || a.tint !== 0 ||
        a.highlights !== 0 || a.shadows !== 0 || a.vignette !== 0 || a.noise !== 0;
    }

    _getPreviewSource(scale) {
      const key = idOf(this.base) + '|' + scale.toFixed(5);
      if (this._previewBase && this._previewBase.key === key) return this._previewBase.canvas;
      const b = this.base;
      const canvas = resample(b, b.width, b.height, b.width * scale, b.height * scale);
      this._previewBase = { key, canvas };
      return canvas;
    }

    // Returns a canvas with base + adjustments + filter (no paint), at `scale` of full size.
    _getProcessed(scale) {
      const a = this._adj;
      const needColor = this._needsColorPass();
      if (!needColor && a.blur === 0 && a.sharpen === 0) return this.base;

      const slot = scale < 1 ? 'preview' : 'full';
      const key = idOf(this.base) + '|' + scale.toFixed(5) + '|' + this._filter + '|' + JSON.stringify(a) +
        '|' + (this._curveLut ? this._curveKey : '');
      const cached = this._cache[slot];
      if (cached && cached.key === key) return cached.canvas;

      const src = scale < 1 ? this._getPreviewSource(scale) : this.base;
      const w = src.width, h = src.height;
      let work = this._work[slot];
      if (!work) {
        work = { canvas: createCanvas(w, h) };
        work.ctx = work.canvas.getContext('2d', { willReadFrequently: true });
        this._work[slot] = work;
      }
      if (work.canvas.width !== w) work.canvas.width = w;
      if (work.canvas.height !== h) work.canvas.height = h;
      const ctx = work.ctx;
      const hasFilter = supportsCtxFilter();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      if (hasFilter) ctx.filter = 'none';
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(src, 0, 0);

      const blur = a.blur * scale;
      if (blur > 0 && hasFilter) {
        // Blurred copy drawn over the sharp one so edges don't fade to transparent.
        ctx.filter = 'blur(' + blur.toFixed(2) + 'px)';
        ctx.drawImage(src, 0, 0);
        ctx.filter = 'none';
      }
      const fallbackBlur = blur > 0 && !hasFilter;
      if (fallbackBlur || a.sharpen > 0 || needColor) {
        const img = ctx.getImageData(0, 0, w, h);
        if (fallbackBlur) boxBlur(img.data, w, h, blur);
        if (a.sharpen > 0) sharpenData(img.data, w, h, a.sharpen / 100 * 1.2);
        if (needColor) this._colorPass(img.data, w, h);
        ctx.putImageData(img, 0, 0);
      }
      this._cache[slot] = { key, canvas: work.canvas };
      return work.canvas;
    }

    // Single per-pixel pass: tone LUTs, highlights/shadows, adjustment matrix, master curve,
    // filter matrix, filter curves, split toning, vignette, noise.
    _colorPass(d, w, h) {
      const a = this._adj;

      // Stage 1: per-channel LUTs (exposure, temperature/tint, brightness, contrast).
      const expo = Math.pow(2, a.exposure / 100 * 1.5);
      const bright = a.brightness * 0.75;
      const cv = a.contrast;
      const cf = (259 * (cv + 255)) / (255 * (259 - cv));
      const t = a.temperature / 100, ti = a.tint / 100;
      const offs = [t * 32 + ti * 10, -ti * 26, -t * 32 + ti * 10];
      const L0 = new Float32Array(256), L1 = new Float32Array(256), L2 = new Float32Array(256);
      const luts = [L0, L1, L2];
      for (let ch = 0; ch < 3; ch++) {
        const L = luts[ch], o = offs[ch] + bright;
        for (let i = 0; i < 256; i++) {
          let v = i * expo + o;
          v = (v - 128) * cf + 128;
          L[i] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }

      // Colour matrices: adjustment hue/saturation, then (after the tone curve) the filter matrix.
      // Without a curve both are merged into one matrix.
      const f = getFilterDef(this._filter);
      const tc = this._curveLut; // master RGB curve, applied after adjustments, before filter
      let m = null;
      if (a.saturation !== 0 || a.hue !== 0) m = mulMat(hueMatrix(a.hue), satMatrix(1 + a.saturation / 100));
      let fm = f && f.matrix ? f.matrix : null;
      if (!tc && fm) { m = m ? mulMat(fm, m) : fm; fm = null; }
      const useM = !!m;
      const m0 = useM ? m[0] : 0, m1 = useM ? m[1] : 0, m2 = useM ? m[2] : 0;
      const m3 = useM ? m[3] : 0, m4 = useM ? m[4] : 0, m5 = useM ? m[5] : 0;
      const m6 = useM ? m[6] : 0, m7 = useM ? m[7] : 0, m8 = useM ? m[8] : 0;
      const useF = !!fm;
      const n0 = useF ? fm[0] : 0, n1 = useF ? fm[1] : 0, n2 = useF ? fm[2] : 0;
      const n3 = useF ? fm[3] : 0, n4 = useF ? fm[4] : 0, n5 = useF ? fm[5] : 0;
      const n6 = useF ? fm[6] : 0, n7 = useF ? fm[7] : 0, n8 = useF ? fm[8] : 0;

      const curves = f && f.curves;
      const cR = curves ? curves[0] : null, cG = curves ? curves[1] : null, cB = curves ? curves[2] : null;
      const split = f && f.split;
      const s0 = split ? split.shadow[0] : 0, s1 = split ? split.shadow[1] : 0, s2 = split ? split.shadow[2] : 0;
      const h0 = split ? split.highlight[0] : 0, h1 = split ? split.highlight[1] : 0, h2 = split ? split.highlight[2] : 0;

      const hasHS = a.highlights !== 0 || a.shadows !== 0;
      const sh = a.shadows / 100 * 90, hl = a.highlights / 100 * 90;
      const vig = a.vignette / 100 * 0.9;
      const noise = a.noise / 100 * 70;
      let seed = (0x2f6b4a1d ^ (w * 7919 + h)) | 0 || 1; // deterministic: noise doesn't flicker

      const cx = w / 2, cy = h / 2, icx = 1 / cx, icy = 1 / cy;
      let i = 0;
      for (let y = 0; y < h; y++) {
        const dy = (y + 0.5 - cy) * icy, dy2 = dy * dy;
        for (let x = 0; x < w; x++, i += 4) {
          let r = L0[d[i]], g = L1[d[i + 1]], b = L2[d[i + 2]];

          if (hasHS) {
            const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255, il = 1 - l;
            const dl = sh * il * il + hl * l * l;
            r += dl; g += dl; b += dl;
          }
          if (useM) {
            const nr = m0 * r + m1 * g + m2 * b;
            const ng = m3 * r + m4 * g + m5 * b;
            const nb = m6 * r + m7 * g + m8 * b;
            r = nr; g = ng; b = nb;
          }
          if (tc) {
            r = tc[r < 0 ? 0 : r > 255 ? 255 : r | 0];
            g = tc[g < 0 ? 0 : g > 255 ? 255 : g | 0];
            b = tc[b < 0 ? 0 : b > 255 ? 255 : b | 0];
          }
          if (useF) {
            const nr = n0 * r + n1 * g + n2 * b;
            const ng = n3 * r + n4 * g + n5 * b;
            const nb = n6 * r + n7 * g + n8 * b;
            r = nr; g = ng; b = nb;
          }
          if (cR) {
            r = cR[r < 0 ? 0 : r > 255 ? 255 : r | 0];
            g = cG[g < 0 ? 0 : g > 255 ? 255 : g | 0];
            b = cB[b < 0 ? 0 : b > 255 ? 255 : b | 0];
          }
          if (split) {
            const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255, il = 1 - l;
            r += il * s0 + l * h0;
            g += il * s1 + l * h1;
            b += il * s2 + l * h2;
          }
          if (vig > 0) {
            const dx = (x + 0.5 - cx) * icx;
            let tt = (Math.sqrt((dx * dx + dy2) * 0.5) - 0.35) / 0.65;
            if (tt > 0) {
              if (tt > 1) tt = 1;
              const fv = 1 - vig * tt * tt * (3 - 2 * tt);
              r *= fv; g *= fv; b *= fv;
            }
          }
          if (noise > 0) {
            seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
            const n = ((seed >>> 0) / 4294967296 - 0.5) * noise;
            r += n; g += n; b += n;
          }
          d[i] = r; d[i + 1] = g; d[i + 2] = b; // Uint8ClampedArray clamps + rounds
        }
      }
    }

    /* ---------------- pointer handling ---------------- */

    // Image pixels per CSS pixel of the visible canvas.
    _screenScale() {
      const r = this.canvas.getBoundingClientRect();
      return r.width > 0 ? this.canvas.width / r.width : 1;
    }

    _toImage(e) {
      const r = this.canvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * (r.width ? this.canvas.width / r.width : 1),
        y: (e.clientY - r.top) * (r.height ? this.canvas.height / r.height : 1)
      };
    }

    _updateCursor(hit) {
      let cur = '';
      switch (this._tool) {
        case 'crop': cur = (hit && HANDLE_CURSORS[hit]) || 'crosshair'; break;
        case 'brush':
        case 'eraser':
        case 'shape':
        case 'eyedropper': cur = 'crosshair'; break;
        case 'text': cur = 'text'; break;
        default: cur = 'default';
      }
      if (this.canvas.style.cursor !== cur) this.canvas.style.cursor = cur;
    }

    _onPointerDown(e) {
      if (!this.base || this._tool === 'none') return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (this._pointerId !== null) return;
      const p = this._toImage(e);
      e.preventDefault();

      if (this._tool === 'text') { this._stampText(p.x, p.y); return; }

      try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      this._pointerId = e.pointerId;

      if (this._tool === 'brush' || this._tool === 'eraser') {
        this._hover = p;
        this._beginStroke(p.x, p.y);
        this._requestRender();
      } else if (this._tool === 'eyedropper') {
        this._picking = true;
        this._lastPick = null;
        this._pick(p);
      } else if (this._tool === 'shape') {
        const sh = this._shape;
        this._shapeDrag = {
          type: sh.type, color: sh.color, fill: sh.fill, opacity: sh.opacity,
          size: Math.max(1, sh.size * this._screenScale()),
          start: p, end: p, shift: !!e.shiftKey
        };
        this._requestRender();
      } else if (this._tool === 'crop') {
        if (!this._crop) this._initCrop();
        const hit = this._hitCrop(p.x, p.y, e.pointerType === 'touch');
        const prev = Object.assign({}, this._crop);
        if (hit === 'inside') this._drag = { mode: 'move', start: p, rect: prev, prev };
        else if (hit) this._drag = { mode: 'resize', handle: hit, start: p, rect: prev, prev };
        else {
          const sx = clamp(p.x, 0, this.base.width), sy = clamp(p.y, 0, this.base.height);
          this._drag = { mode: 'new', start: p, rect: { x: sx, y: sy, w: 0, h: 0 }, prev };
        }
        this._updateCursor(hit || 'crosshair');
      }
    }

    _onPointerMove(e) {
      if (!this.base) return;
      if (this._pointerId === e.pointerId) {
        if (this._stroke) {
          const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
          const list = evs && evs.length ? evs : [e];
          for (const ev of list) {
            const q = this._toImage(ev);
            this._extendStroke(q.x, q.y);
          }
          this._hover = this._toImage(e);
          this._requestRender();
        } else if (this._picking) {
          this._pick(this._toImage(e));
        } else if (this._shapeDrag) {
          this._shapeDrag.end = this._toImage(e);
          this._shapeDrag.shift = !!e.shiftKey;
          this._requestRender();
        } else if (this._drag) {
          this._updateCropDrag(this._toImage(e));
          this._requestRender();
        }
        return;
      }
      if (this._pointerId !== null) return;
      const p = this._toImage(e);
      if (this._tool === 'crop') {
        this._updateCursor(this._hitCrop(p.x, p.y, e.pointerType === 'touch'));
      } else if (this._tool === 'brush' || this._tool === 'eraser') {
        if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
          this._hover = p;
          this._requestRender();
        }
      }
    }

    _onPointerUp(e) {
      if (this._pointerId !== e.pointerId) return;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      this._pointerId = null;
      if (this._stroke) {
        this._endStroke();
        if (e.pointerType === 'touch') this._hover = null;
      }
      this._picking = false;
      if (this._shapeDrag) {
        if (e.type === 'pointercancel') this._shapeDrag = null;
        else {
          this._shapeDrag.end = this._toImage(e);
          this._shapeDrag.shift = !!e.shiftKey;
          this._endShape();
        }
      }
      if (this._drag) {
        const c = this._crop;
        if (!c || c.w < 2 || c.h < 2) this._crop = this._drag.prev; // tiny accidental tap
        this._drag = null;
        const p = this._toImage(e);
        this._updateCursor(this._hitCrop(p.x, p.y, e.pointerType === 'touch'));
      }
      this._requestRender();
    }

    _onPointerLeave() {
      if (this._pointerId !== null) return;
      if (this._hover) { this._hover = null; this._requestRender(); }
    }

    // Drop any in-progress gesture without committing it.
    _cancelInteraction() {
      if (this._pointerId !== null) {
        try { this.canvas.releasePointerCapture(this._pointerId); } catch (_) { /* ignore */ }
      }
      this._pointerId = null;
      this._stroke = null;
      this._drag = null;
      this._shapeDrag = null;
      this._picking = false;
    }

    /* ---------------- brush ---------------- */

    _beginStroke(x, y) {
      this._ensurePaintOwned();
      const W = this.base.width, H = this.base.height;
      if (!this._strokeCanvas || this._strokeCanvas.width !== W || this._strokeCanvas.height !== H) {
        this._strokeCanvas = createCanvas(W, H);
      }
      const sctx = this._strokeCanvas.getContext('2d');
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.clearRect(0, 0, W, H);
      const size = Math.max(1, this._brush.size * this._screenScale());
      const mode = this._tool === 'eraser' ? 'eraser' : 'brush';
      const color = mode === 'brush' ? this._brush.color : '#000000';
      this._stroke = { mode, size, color, opacity: this._brush.opacity, last: { x, y }, mid: { x, y } };
      // Strokes are drawn opaque on a temp canvas, opacity applied once on merge (no overlap darkening).
      sctx.fillStyle = color;
      sctx.beginPath();
      sctx.arc(x, y, size / 2, 0, Math.PI * 2);
      sctx.fill();
    }

    _strokeCtx() {
      const s = this._stroke, sctx = this._strokeCanvas.getContext('2d');
      sctx.lineCap = 'round';
      sctx.lineJoin = 'round';
      sctx.lineWidth = s.size;
      sctx.strokeStyle = s.color;
      return sctx;
    }

    // Smooth stroke: quadratic curves through midpoints of successive pointer samples.
    _extendStroke(x, y) {
      const s = this._stroke;
      if (!s) return;
      const dx = x - s.last.x, dy = y - s.last.y;
      if (dx * dx + dy * dy < 0.25) return;
      const mid = { x: (s.last.x + x) / 2, y: (s.last.y + y) / 2 };
      const sctx = this._strokeCtx();
      sctx.beginPath();
      sctx.moveTo(s.mid.x, s.mid.y);
      sctx.quadraticCurveTo(s.last.x, s.last.y, mid.x, mid.y);
      sctx.stroke();
      s.mid = mid;
      s.last = { x, y };
    }

    _endStroke() {
      const s = this._stroke;
      if (!s) return;
      const sctx = this._strokeCtx();
      sctx.beginPath();
      sctx.moveTo(s.mid.x, s.mid.y);
      sctx.lineTo(s.last.x, s.last.y);
      sctx.stroke();

      const pctx = this.paint.getContext('2d');
      pctx.save();
      pctx.globalAlpha = s.opacity;
      pctx.globalCompositeOperation = s.mode === 'brush' ? 'source-over' : 'destination-out';
      pctx.drawImage(this._strokeCanvas, 0, 0);
      pctx.restore();
      sctx.clearRect(0, 0, this._strokeCanvas.width, this._strokeCanvas.height);

      this._stroke = null;
      this._pushHistory(s.mode === 'brush' ? 'Кисть' : 'Ластик');
    }

    /* ---------------- shapes ---------------- */

    // Rasterise the finished shape drag into the paint layer.
    _endShape() {
      const s = this._shapeDrag;
      this._shapeDrag = null;
      if (!s) return;
      const g = shapeGeometry(s);
      if (Math.hypot(g.x1 - g.x0, g.y1 - g.y0) < 2) return; // tiny accidental drag
      this._ensurePaintOwned();
      drawShape(this.paint.getContext('2d'), s);
      this._pushHistory('Фигура');
    }

    /* ---------------- text ---------------- */

    _stampText(x, y) {
      const t = this._text;
      const str = String(t.text == null ? '' : t.text);
      if (!str.trim()) return;
      this._ensurePaintOwned();
      const size = Math.max(1, t.size * this._screenScale());
      const ctx = this.paint.getContext('2d');
      ctx.save();
      ctx.font = (t.bold ? 'bold ' : '') + size.toFixed(1) + 'px ' + t.font;
      ctx.fillStyle = t.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lines = str.split(/\r?\n/);
      const lh = size * 1.2;
      const y0 = y - (lines.length - 1) * lh / 2;
      lines.forEach((ln, i) => ctx.fillText(ln, x, y0 + i * lh));
      ctx.restore();
      this._pushHistory('Текст');
      this._requestRender();
    }
  }

  PhotoEditor.ADJUSTMENTS = ADJUSTMENTS;
  PhotoEditor.FILTERS = FILTERS.slice();
  PhotoEditor.TOOLS = TOOLS.slice();

  window.PhotoEditor = PhotoEditor;
})();
