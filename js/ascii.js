/*
 * AsciiEngine - dependency-free image/text -> ASCII-art logo engine.
 * Plain ES2020, classic <script>. Exposes window.AsciiEngine.
 *
 * Tone convention (important):
 *   Every ramp in CHARSETS is ordered LIGHT (empty) -> DARK (dense).
 *   By default (invert=false) DARK pixels get DENSE chars and light pixels
 *   become spaces. That matches "black ink on white paper" and also
 *   "light-colored text on a dark canvas" (the drawn chars are the logo).
 *   invert=true swaps this: BRIGHT pixels get dense chars (use it for a
 *   light logo on a dark photo background when you want the light parts drawn).
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- charsets
  // Paul Bourke's 70-level ramp is published dark -> light; we reverse it.
  const BOURKE = '$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,"^`\'. ';

  const CHARSETS = {
    standard: ' .:-=+*#%@',
    detailed: Array.from(BOURKE).reverse().join(''),
    blocks: ' ░▒▓█',
    simple: ' .oO@',
    binary: ' 01',
    dots: ' ⠁⠃⠇⠏⠟⠿⡿⣿',
    lines: ' .-~=≡',
    hacker: ' .:;+=xX$&'
  };

  const DEFAULT_FONT = '"Cascadia Mono", Consolas, "Courier New", monospace';
  const DEFAULT_TEXT_FONT = '900 200px Arial Black, Impact, sans-serif';
  const COLOR_MODES = ['mono', 'original', 'gradient', 'rainbow'];
  const MAX_CANVAS_DIM = 16384;
  const MAX_CANVAS_AREA = 1.6e8;

  // ---------------------------------------------------------------- helpers
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function num(v, def) { const n = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(n) ? n : def; }

  function createCanvas(w, h) {
    if (typeof document !== 'undefined' && document.createElement) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    }
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    throw new Error('AsciiEngine: no canvas implementation available');
  }

  // Reusable offscreen sampling canvas (avoids reallocation per convert()).
  let scratch = null;
  function getScratch(w, h) {
    if (!scratch) {
      const canvas = createCanvas(w, h);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      scratch = { canvas, ctx };
    }
    if (scratch.canvas.width !== w) scratch.canvas.width = w;
    if (scratch.canvas.height !== h) scratch.canvas.height = h;
    return scratch;
  }

  // Tiny context used only to normalise CSS colour strings.
  let colorCtx = null;
  function parseColorLiteral(c) {
    let m = /^#([0-9a-f]{3,8})$/i.exec(c);
    if (m) {
      let h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map(x => x + x).join('');
      if (h.length >= 6) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
      return null;
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(c);
    if (m) return [clamp(Math.round(+m[1]), 0, 255), clamp(Math.round(+m[2]), 0, 255), clamp(Math.round(+m[3]), 0, 255)];
    return null;
  }
  function parseColor(c, fallback) {
    if (typeof c !== 'string' || !c.trim()) return fallback;
    c = c.trim();
    const lit = parseColorLiteral(c);
    if (lit) return lit;
    try {
      if (!colorCtx) colorCtx = createCanvas(1, 1).getContext('2d');
      colorCtx.fillStyle = '#000000';
      colorCtx.fillStyle = c; // browser normalises named colours, hsl(), etc.
      const v = parseColorLiteral(String(colorCtx.fillStyle));
      if (v) return v;
    } catch (e) { /* ignore */ }
    return fallback;
  }

  function hex2(v) { return (v < 16 ? '0' : '') + v.toString(16); }
  function toHex(rgb) { return '#' + hex2(rgb[0]) + hex2(rgb[1]) + hex2(rgb[2]); }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = t => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
  }

  function escHTML(s) {
    return s.replace(/[&<>"']/g, ch => ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;');
  }

  function sourceSize(s) {
    if (!s) return { w: 0, h: 0 };
    const w = s.naturalWidth || s.videoWidth || s.displayWidth || s.width || 0;
    const h = s.naturalHeight || s.videoHeight || s.displayHeight || s.height || 0;
    return { w: +w || 0, h: +h || 0 };
  }

  function resolveRamp(opts) {
    let s = null;
    const key = opts.charset;
    if (key === 'custom') s = opts.customChars;
    else if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(CHARSETS, key)) s = CHARSETS[key];
    else if (typeof key === 'string' && Array.from(key).length >= 2) s = key; // raw ramp string
    let arr = Array.from(typeof s === 'string' ? s : '').filter(ch => ch !== '\n' && ch !== '\r' && ch !== '\t');
    if (arr.length < 2) arr = Array.from(CHARSETS.standard);
    return arr;
  }

  // ---------------------------------------------------------------- convert
  function convert(source, opts) {
    opts = opts || {};
    const size = sourceSize(source);
    if (!size.w || !size.h) throw new Error('AsciiEngine.convert: source has no size (image not loaded?)');

    const cols = Math.round(clamp(num(opts.width, 100), 10, 400));
    const charAspect = clamp(num(opts.charAspect, 0.5), 0.05, 4);
    const rows = Math.round(clamp(Math.round(cols * size.h / size.w * charAspect), 1, 2000));
    const N = cols * rows;
    const ramp = resolveRamp(opts);
    const levels = ramp.length - 1;
    const invert = !!opts.invert;

    // --- Sample: browser downscale to (cols*k)x(rows*k), then k*k box average
    // (true area averaging with alpha weighting). Never touches full-res pixels.
    const k = Math.max(1, Math.min(4, Math.floor(Math.min(size.w / cols, size.h / rows))));
    const sw = cols * k, sh = rows * k;
    const { ctx } = getScratch(sw, sh);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'copy';
    ctx.clearRect(0, 0, sw, sh);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, sw, sh);
    ctx.globalCompositeOperation = 'source-over';
    const d = ctx.getImageData(0, 0, sw, sh).data;

    const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N), A = new Float32Array(N);
    const kk = k * k;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        let sr = 0, sg = 0, sb = 0, sa = 0;
        for (let yy = 0; yy < k; yy++) {
          let p = ((cy * k + yy) * sw + cx * k) * 4;
          for (let xx = 0; xx < k; xx++, p += 4) {
            const a = d[p + 3];
            sr += d[p] * a; sg += d[p + 1] * a; sb += d[p + 2] * a; sa += a;
          }
        }
        const i = cy * cols + cx;
        if (sa > 0) { R[i] = sr / sa; G[i] = sg / sa; B[i] = sb / sa; }
        A[i] = sa / kk;
      }
    }

    // --- Background mask: fully transparent always; with removeBg also
    // alpha<128 and colours near the auto-detected border colour.
    const removeBg = !!opts.removeBg;
    const bg = removeBg ? detectBg(R, G, B, A, cols, rows) : null;
    const tol = clamp(num(opts.bgTolerance, 40), 0, 255), tol2 = tol * tol;
    const removed = new Uint8Array(N);
    const alphaCut = removeBg ? 128 : 8;
    for (let i = 0; i < N; i++) {
      if (A[i] < alphaCut) { removed[i] = 1; continue; }
      if (bg) {
        const dr = R[i] - bg[0], dg = G[i] - bg[1], db = B[i] - bg[2];
        if (dr * dr + dg * dg + db * db <= tol2) removed[i] = 1;
      }
    }

    // --- Luminance + tone adjustments. Semi-transparent pixels are composited
    // onto the "empty" tone so they fade towards spaces.
    const empty = invert ? 0 : 255;
    const bri = clamp(num(opts.brightness, 0), -100, 100) * 2.55;
    const con = clamp(num(opts.contrast, 0), -100, 100) * 2.55;
    const cf = (259 * (con + 255)) / (255 * (259 - con));
    const gam = clamp(num(opts.gamma, 1), 0.2, 3);
    const ig = 1 / gam; // gamma > 1 brightens, < 1 darkens
    const V = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const af = A[i] / 255;
      let v = (0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i]) * af + empty * (1 - af);
      v = cf * (v + bri - 128) + 128;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      if (gam !== 1) v = 255 * Math.pow(v / 255, ig);
      V[i] = v;
    }

    if (opts.sharpen) sharpenGrid(V, cols, rows, 0.8);

    const chars = new Array(N);
    if (opts.edges) {
      edgeChars(V, removed, cols, rows, clamp(num(opts.edgeThreshold, 60), 0, 255), opts.edgeThin !== false, chars);
    } else {
      // Map to fractional ramp level (0 = empty, levels = densest).
      const L = new Float32Array(N);
      for (let i = 0; i < N; i++) L[i] = (invert ? V[i] : 255 - V[i]) / 255 * levels;
      if (opts.dither) ditherFS(L, removed, cols, rows, levels);
      for (let i = 0; i < N; i++) {
        if (removed[i]) { chars[i] = ' '; continue; }
        const q = Math.round(L[i]);
        chars[i] = ramp[q < 0 ? 0 : q > levels ? levels : q];
      }
    }

    // --- Build result
    const cells = new Array(N);
    const lines = new Array(rows);
    for (let y = 0; y < rows; y++) {
      let line = '';
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        const ch = chars[i];
        cells[i] = { ch, r: Math.round(R[i]), g: Math.round(G[i]), b: Math.round(B[i]), a: removed[i] ? 0 : Math.round(A[i]) };
        line += ch;
      }
      lines[y] = line;
    }
    const trimmed = lines.map(l => l.replace(/ +$/, ''));
    let t0 = 0, t1 = trimmed.length;
    while (t0 < t1 && trimmed[t0] === '') t0++;
    while (t1 > t0 && trimmed[t1 - 1] === '') t1--;

    return {
      cols, rows,
      text: lines.join('\n'),
      textTrimmed: trimmed.slice(t0, t1).join('\n'),
      cells,
      charset: ramp.join(''),
      bgColor: bg ? [Math.round(bg[0]), Math.round(bg[1]), Math.round(bg[2])] : null
    };
  }

  // Median colour of opaque border cells; null if the border is mostly transparent.
  function detectBg(R, G, B, A, cols, rows) {
    const rs = [], gs = [], bs = [];
    let total = 0;
    const push = i => { total++; if (A[i] >= 128) { rs.push(R[i]); gs.push(G[i]); bs.push(B[i]); } };
    for (let x = 0; x < cols; x++) { push(x); if (rows > 1) push((rows - 1) * cols + x); }
    for (let y = 1; y < rows - 1; y++) { push(y * cols); if (cols > 1) push(y * cols + cols - 1); }
    if (!rs.length || rs.length < total * 0.25) return null;
    const med = a => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
    return [med(rs), med(gs), med(bs)];
  }

  // Light unsharp mask on the grid (3x3 box blur as the low-pass).
  function sharpenGrid(V, cols, rows, amount) {
    const src = V.slice();
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= rows) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= cols) continue;
            s += src[yy * cols + xx]; n++;
          }
        }
        const i = y * cols + x;
        const v = src[i] + amount * (src[i] - s / n);
        V[i] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }

  // Serpentine Floyd-Steinberg on fractional ramp levels; skips masked cells.
  function ditherFS(L, removed, cols, rows, levels) {
    for (let y = 0; y < rows; y++) {
      const ltr = (y & 1) === 0;
      const dir = ltr ? 1 : -1;
      for (let n = 0; n < cols; n++) {
        const x = ltr ? n : cols - 1 - n;
        const i = y * cols + x;
        if (removed[i]) continue;
        const old = L[i];
        let q = Math.round(old);
        q = q < 0 ? 0 : q > levels ? levels : q;
        L[i] = q;
        const err = old - q;
        if (!err) continue;
        const xn = x + dir, xp = x - dir;
        if (xn >= 0 && xn < cols && !removed[i + dir]) L[i + dir] += err * 7 / 16;
        if (y + 1 < rows) {
          const j = i + cols;
          if (xp >= 0 && xp < cols && !removed[j - dir]) L[j - dir] += err * 3 / 16;
          if (!removed[j]) L[j] += err * 5 / 16;
          if (xn >= 0 && xn < cols && !removed[j + dir]) L[j + dir] += err * 1 / 16;
        }
      }
    }
  }

  // Sobel edge detection -> directional chars. Optional non-max suppression thins lines.
  function edgeChars(V, removed, cols, rows, thr, thin, out) {
    const N = cols * rows;
    const MAG = new Float32Array(N);
    const BIN = new Uint8Array(N);
    const at = (x, y) => V[(y < 0 ? 0 : y >= rows ? rows - 1 : y) * cols + (x < 0 ? 0 : x >= cols ? cols - 1 : x)];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const tl = at(x - 1, y - 1), tm = at(x, y - 1), tr = at(x + 1, y - 1);
        const ml = at(x - 1, y), mr = at(x + 1, y);
        const bl = at(x - 1, y + 1), bm = at(x, y + 1), br = at(x + 1, y + 1);
        const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
        const gy = (bl + 2 * bm + br) - (tl + 2 * tm + tr);
        const i = y * cols + x;
        MAG[i] = Math.sqrt(gx * gx + gy * gy) / 4;
        let a = Math.atan2(gy, gx) * 180 / Math.PI;
        if (a < 0) a += 180;
        BIN[i] = Math.round(a / 45) % 4; // gradient direction bin
      }
    }
    // Edge runs perpendicular to the gradient (y axis points down).
    const EDGE = ['|', '/', '-', '\\'];
    const NB = [[1, 0], [1, 1], [0, 1], [-1, 1]]; // neighbour offsets along gradient
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        const m = MAG[i];
        if (removed[i] || m < thr) { out[i] = ' '; continue; }
        if (thin) {
          const o = NB[BIN[i]];
          const x1 = x + o[0], y1 = y + o[1], x2 = x - o[0], y2 = y - o[1];
          const m1 = (x1 >= 0 && x1 < cols && y1 >= 0 && y1 < rows) ? MAG[y1 * cols + x1] : 0;
          const m2 = (x2 >= 0 && x2 < cols && y2 >= 0 && y2 < rows) ? MAG[y2 * cols + x2] : 0;
          if (m < m1 || m < m2) { out[i] = ' '; continue; }
        }
        out[i] = EDGE[BIN[i]];
      }
    }
  }

  // ---------------------------------------------------------------- textToCanvas
  function textToCanvas(text, opts) {
    opts = opts || {};
    let font = opts.font || DEFAULT_TEXT_FONT;
    const pad = Math.max(0, num(opts.padding, 20));
    const color = opts.color || '#000000';
    const bg = opts.bg || opts.background || '#ffffff';
    const lineHeight = clamp(num(opts.lineHeight, 1.1), 0.5, 3);
    const align = opts.align || 'center';
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');

    const canvas = createCanvas(1, 1);
    const ctx = canvas.getContext('2d');
    const fontSize = f => { const m = /(\d*\.?\d+)px/.exec(f); return m ? parseFloat(m[1]) : 200; };

    let layout;
    for (let attempt = 0; attempt < 3; attempt++) {
      ctx.font = font;
      const size = fontSize(font);
      let asc = 0, desc = 0, maxW = 0;
      const ms = lines.map(l => {
        const m = ctx.measureText(l);
        const left = Number.isFinite(m.actualBoundingBoxLeft) ? m.actualBoundingBoxLeft : 0;
        const right = Number.isFinite(m.actualBoundingBoxRight) ? m.actualBoundingBoxRight : m.width;
        const w = Math.max(m.width, left + right);
        if (l.trim()) {
          asc = Math.max(asc, Number.isFinite(m.actualBoundingBoxAscent) ? m.actualBoundingBoxAscent : size * 0.8);
          desc = Math.max(desc, Number.isFinite(m.actualBoundingBoxDescent) ? m.actualBoundingBoxDescent : size * 0.2);
        }
        maxW = Math.max(maxW, w);
        return { w, left };
      });
      if (!asc && !desc) { asc = size * 0.8; desc = size * 0.2; }
      const step = size * lineHeight;
      const W = Math.ceil(maxW + pad * 2), H = Math.ceil(asc + desc + (lines.length - 1) * step + pad * 2);
      layout = { ms, asc, step, maxW, W: Math.max(1, W), H: Math.max(1, H) };
      const f = Math.min(1, 8192 / layout.W, 8192 / layout.H);
      if (f >= 1) break;
      // Too large for a canvas: shrink the font and re-measure.
      font = font.replace(/(\d*\.?\d+)px/, Math.max(8, Math.floor(size * f)) + 'px');
    }

    canvas.width = layout.W; canvas.height = layout.H;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, layout.W, layout.H);
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    lines.forEach((l, i) => {
      const m = layout.ms[i];
      let x = pad + m.left;
      if (align === 'center') x += (layout.maxW - m.w) / 2;
      else if (align === 'right') x += layout.maxW - m.w;
      ctx.fillText(l, x, pad + layout.asc + i * layout.step);
    });
    return canvas;
  }

  // ---------------------------------------------------------------- styles / colours
  function normStyle(style) {
    style = style || {};
    return {
      fontFamily: style.fontFamily || DEFAULT_FONT,
      fontSize: clamp(num(style.fontSize, 10), 2, 400),
      lineHeight: clamp(num(style.lineHeight, 1), 0.3, 4),
      colorMode: COLOR_MODES.indexOf(style.colorMode) >= 0 ? style.colorMode : 'mono',
      fg: style.fg || '#00ff88',
      fg2: style.fg2 || '#0088ff',
      bg: style.bg || '#0b0d10',
      transparentBg: !!style.transparentBg,
      scale: clamp(num(style.scale, 1), 0.1, 8),
      glow: clamp(num(style.glow, 0), 0, 20),
      padding: Math.max(0, num(style.padding, 16))
    };
  }

  // Quantise cell colour (step 4) so neighbouring near-identical colours merge into runs.
  function qc(v) { return clamp((v + 2) & ~3, 0, 255); }

  // Per-cell colour for string exporters: returns fn(cell, x, y) -> [r,g,b], or null for mono.
  function makeCellColor(result, s) {
    if (s.colorMode === 'original') return c => [qc(c.r), qc(c.g), qc(c.b)];
    if (s.colorMode === 'gradient') {
      const a = parseColor(s.fg, [0, 255, 136]), b = parseColor(s.fg2, [0, 136, 255]);
      const rowsC = [];
      const den = Math.max(1, result.rows - 1);
      for (let y = 0; y < result.rows; y++) {
        const t = y / den;
        rowsC.push([Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)]);
      }
      return (c, x, y) => rowsC[y];
    }
    if (s.colorMode === 'rainbow') {
      const cache = new Map();
      return (c, x) => {
        const h = (Math.round(x / result.cols * 60) * 6) % 360; // 6 degree buckets
        let v = cache.get(h);
        if (!v) { v = hslToRgb(h, 1, 0.6); cache.set(h, v); }
        return v;
      };
    }
    return null;
  }

  // ---------------------------------------------------------------- render (canvas)
  const glyphCache = new Map(); // font -> Map(ch -> fitsCell)

  function render(result, canvas, style) {
    if (!result || !canvas) return;
    const s = normStyle(style);
    const ctx = canvas.getContext('2d');
    const cols = result.cols, rows = result.rows, cells = result.cells;

    let fs = s.fontSize * s.scale;
    let font = fs + 'px ' + s.fontFamily;
    ctx.font = font;
    let cw = ctx.measureText('M').width || fs * 0.6;
    let W = cw * cols, H = fs * s.lineHeight * rows;
    // Keep within browser canvas limits.
    const f = Math.min(1, MAX_CANVAS_DIM / W, MAX_CANVAS_DIM / H, Math.sqrt(MAX_CANVAS_AREA / (W * H)));
    if (f < 1) {
      fs *= f; font = fs + 'px ' + s.fontFamily; ctx.font = font;
      cw = ctx.measureText('M').width || fs * 0.6;
    }
    const lh = fs * s.lineHeight;
    W = Math.max(1, Math.ceil(cw * cols)); H = Math.max(1, Math.ceil(lh * rows));
    canvas.width = W; canvas.height = H; // resets context state

    if (s.transparentBg) ctx.clearRect(0, 0, W, H);
    else { ctx.fillStyle = s.bg; ctx.fillRect(0, 0, W, H); }

    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    // Glyph advance per char. Chars whose advance differs from the 'M' cell
    // (font fallback for blocks/braille) are grouped into runs of equal advance
    // and drawn with a horizontal scale so they still snap to the grid.
    let adv = glyphCache.get(font);
    if (!adv) { adv = new Map(); glyphCache.set(font, adv); }
    const advOf = ch => {
      let v = adv.get(ch);
      if (v === undefined) {
        const w = ctx.measureText(ch).width;
        v = (!(w > 0) || Math.abs(w - cw) <= cw * 0.02 + 0.01) ? cw : w;
        adv.set(ch, v);
      }
      return v;
    };

    const fgCss = s.fg;
    if (s.glow > 0) { ctx.shadowBlur = s.glow * s.scale; ctx.shadowColor = fgCss; }

    let colorOf = null; // per-cell CSS colour (original mode only)
    // Rainbow gradient in a run's local (translated + x-scaled) space, so hue stays tied to device x.
    const rainbowFill = (x0, sx) => {
      const g = ctx.createLinearGradient(-x0 / sx, 0, (W - x0) / sx, 0);
      for (let h = 0; h <= 360; h += 30) g.addColorStop(h / 360, 'hsl(' + h + ',100%,60%)');
      return g;
    };
    const rainbow = s.colorMode === 'rainbow';
    if (s.colorMode === 'gradient') {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, s.fg); g.addColorStop(1, s.fg2);
      ctx.fillStyle = g;
    } else if (rainbow) {
      ctx.fillStyle = rainbowFill(0, 1);
    } else if (s.colorMode === 'original') {
      const cache = new Map();
      colorOf = c => {
        const r = qc(c.r), gg = qc(c.g), b = qc(c.b);
        const key = (r << 16) | (gg << 8) | b;
        let css = cache.get(key);
        if (!css) { css = 'rgb(' + r + ',' + gg + ',' + b + ')'; cache.set(key, css); }
        return css;
      };
    } else {
      ctx.fillStyle = fgCss;
    }
    const glowRun = colorOf && s.glow > 0;

    for (let y = 0; y < rows; y++) {
      const cy = (y + 0.5) * lh;
      let run = '', runStart = -1, runColor = null, runAdv = cw;
      const flush = () => {
        if (run) {
          const t = run.replace(/ +$/, '');
          if (t) {
            if (colorOf) { ctx.fillStyle = runColor; if (glowRun) ctx.shadowColor = runColor; }
            const x0 = runStart * cw;
            if (runAdv === cw) {
              ctx.fillText(t, x0, cy);
            } else {
              // Translate/scale on x only, so vertical gradients are unaffected.
              const sx = cw / runAdv;
              ctx.setTransform(sx, 0, 0, 1, x0, 0);
              if (rainbow) ctx.fillStyle = rainbowFill(x0, sx);
              ctx.fillText(t, 0, cy);
              ctx.setTransform(1, 0, 0, 1, 0, 0);
              if (rainbow) ctx.fillStyle = rainbowFill(0, 1);
            }
          }
        }
        run = ''; runStart = -1;
      };
      const base = y * cols;
      for (let x = 0; x < cols; x++) {
        const c = cells[base + x];
        const ch = c.ch;
        if (ch === ' ') { // spaces extend normal runs; they break scaled runs (different advance)
          if (run) { if (runAdv === cw) run += ' '; else flush(); }
          continue;
        }
        const col = colorOf ? colorOf(c) : null;
        const a = advOf(ch);
        if (run && (col !== runColor || a !== runAdv)) flush();
        if (!run) { runStart = x; runColor = col; runAdv = a; }
        run += ch;
      }
      flush();
    }
  }

  // Split a row into colour runs: [{start, text, rgb}] (spaces absorbed, leading/trailing trimmed).
  function rowRuns(result, y, colorFn) {
    const runs = [];
    const cols = result.cols, base = y * cols;
    let cur = null;
    for (let x = 0; x < cols; x++) {
      const c = result.cells[base + x];
      if (c.ch === ' ') { if (cur) cur.text += ' '; continue; }
      const rgb = colorFn ? colorFn(c, x, y) : null;
      if (!cur || (rgb && (rgb[0] !== cur.rgb[0] || rgb[1] !== cur.rgb[1] || rgb[2] !== cur.rgb[2]))) {
        if (cur) cur.text = cur.text.replace(/ +$/, '');
        cur = { start: x, text: '', rgb };
        runs.push(cur);
      }
      cur.text += c.ch;
    }
    if (cur) cur.text = cur.text.replace(/ +$/, '');
    return runs;
  }

  function rowText(result, y) {
    let s = '';
    const base = y * result.cols;
    for (let x = 0; x < result.cols; x++) s += result.cells[base + x].ch;
    return s;
  }

  // ---------------------------------------------------------------- toHTML
  function toHTML(result, style) {
    const s = normStyle(style);
    const colorFn = makeCellColor(result, s);
    const out = [];
    for (let y = 0; y < result.rows; y++) {
      const line = rowText(result, y);
      if (!colorFn) { out.push(escHTML(line)); continue; }
      let html = '', pos = 0;
      for (const r of rowRuns(result, y, colorFn)) {
        // Code-unit-safe: runs are built from cells, so pad with spaces by column.
        if (r.start > pos) html += ' '.repeat(r.start - pos);
        html += '<span style="color:' + toHex(r.rgb) + '">' + escHTML(r.text) + '</span>';
        pos = r.start + Array.from(r.text).length;
      }
      out.push(html);
    }
    const lhPx = +(s.fontSize * s.lineHeight).toFixed(3);
    const shadow = s.glow > 0 ? 'text-shadow:0 0 ' + s.glow + 'px ' + s.fg + ';' : '';
    const bgCss = s.transparentBg ? 'transparent' : s.bg;
    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>ASCII Art</title>\n<style>\n' +
      'html,body{margin:0;background:' + bgCss + ';}\n' +
      'pre.ascii{margin:0;padding:' + s.padding + 'px;font-family:' + s.fontFamily + ';font-size:' + s.fontSize + 'px;' +
      'line-height:' + lhPx + 'px;letter-spacing:0;white-space:pre;color:' + s.fg + ';' + shadow +
      'font-variant-ligatures:none;font-kerning:none;}\n' +
      '</style>\n</head>\n<body>\n<pre class="ascii">' + out.join('\n') + '</pre>\n</body>\n</html>\n';
  }

  // ---------------------------------------------------------------- toSVG
  function toSVG(result, style) {
    const s = normStyle(style);
    const fs = s.fontSize;
    const cw = fs * 0.6; // typical monospace advance; textLength enforces the grid
    const lh = fs * s.lineHeight;
    const W = +(cw * result.cols).toFixed(2), H = +(lh * result.rows).toFixed(2);
    const r2 = v => +v.toFixed(2);
    const parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">');
    const defs = [];
    let fill = escHTML(s.fg);
    if (s.colorMode === 'gradient') {
      defs.push('<linearGradient id="ag" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="' + H + '">' +
        '<stop offset="0" stop-color="' + escHTML(s.fg) + '"/><stop offset="1" stop-color="' + escHTML(s.fg2) + '"/></linearGradient>');
      fill = 'url(#ag)';
    } else if (s.colorMode === 'rainbow') {
      let stops = '';
      for (let h = 0; h <= 360; h += 30) stops += '<stop offset="' + r2(h / 360) + '" stop-color="hsl(' + h + ',100%,60%)"/>';
      defs.push('<linearGradient id="ag" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="' + W + '" y2="0">' + stops + '</linearGradient>');
      fill = 'url(#ag)';
    }
    if (s.glow > 0) {
      defs.push('<filter id="aglow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="' + r2(s.glow / 2) + '" result="b"/>' +
        '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>');
    }
    if (defs.length) parts.push('<defs>' + defs.join('') + '</defs>');
    if (!s.transparentBg) parts.push('<rect width="100%" height="100%" fill="' + escHTML(s.bg) + '"/>');
    parts.push('<g font-family="' + escHTML(s.fontFamily) + '" font-size="' + fs + '" fill="' + fill + '" dominant-baseline="central"' +
      (s.glow > 0 ? ' filter="url(#aglow)"' : '') + '>');

    const original = s.colorMode === 'original';
    const colorFn = original ? makeCellColor(result, s) : null;
    for (let y = 0; y < result.rows; y++) {
      const cy = r2((y + 0.5) * lh);
      if (original) {
        const runs = rowRuns(result, y, colorFn);
        if (!runs.length) continue;
        let t = '<text y="' + cy + '" xml:space="preserve">';
        for (const r of runs) {
          const len = Array.from(r.text).length;
          t += '<tspan x="' + r2(r.start * cw) + '" textLength="' + r2(len * cw) + '" lengthAdjust="spacing" fill="' + toHex(r.rgb) + '">' + escHTML(r.text) + '</tspan>';
        }
        parts.push(t + '</text>');
      } else {
        const line = rowText(result, y).replace(/ +$/, '');
        if (!line) continue;
        const len = Array.from(line).length;
        parts.push('<text x="0" y="' + cy + '" xml:space="preserve" textLength="' + r2(len * cw) + '" lengthAdjust="spacing">' + escHTML(line) + '</text>');
      }
    }
    parts.push('</g>', '</svg>');
    return parts.join('\n') + '\n';
  }

  // ---------------------------------------------------------------- toANSI
  // 24-bit colour; uses each cell's original colour unless a style with another colorMode is given.
  function toANSI(result, style) {
    const s = normStyle(Object.assign({ colorMode: 'original' }, style || {}));
    const colorFn = makeCellColor(result, s);
    const mono = colorFn ? null : parseColor(s.fg, [0, 255, 136]);
    const lines = [];
    for (let y = 0; y < result.rows; y++) {
      const base = y * result.cols;
      let line = '', last = '';
      for (let x = 0; x < result.cols; x++) {
        const c = result.cells[base + x];
        if (c.ch === ' ') { line += ' '; continue; }
        const rgb = colorFn ? colorFn(c, x, y) : mono;
        const code = '\x1b[38;2;' + rgb[0] + ';' + rgb[1] + ';' + rgb[2] + 'm';
        if (code !== last) { line += code; last = code; }
        line += c.ch;
      }
      lines.push(last ? line + '\x1b[0m' : line);
    }
    return lines.join('\n') + '\x1b[0m';
  }

  global.AsciiEngine = {
    CHARSETS,
    convert,
    textToCanvas,
    render,
    toHTML,
    toSVG,
    toANSI
  };
})(typeof window !== 'undefined' ? window : globalThis);
