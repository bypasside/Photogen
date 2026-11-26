/*
 * gif.js - dependency-free GIF decoder + encoder for the browser.
 * Plain classic script; exposes only window.GifCodec.
 *
 *   GifCodec.isGif(arrayBuffer) -> boolean
 *   GifCodec.decode(arrayBuffer) -> { width, height, loopCount, frames: [{ imageData, delay }], truncated? }
 *   GifCodec.encode(frames, opts) -> Promise<Blob>
 *
 * Encoder notes:
 *  - optimize (default true) with transparent=false: each frame after the first is
 *    compared with the previous SOURCE frame (RGB). Unchanged pixels become the
 *    reserved transparent index and the frame is cropped to the bounding box of the
 *    changed pixels; disposal 1 (do not dispose). Because an unchanged source pixel
 *    was quantized the same way (or, with per-frame palettes, to the closest colour of
 *    an earlier palette) the shown result equals what a full frame would show.
 *  - transparent=true: pixel differencing is disabled (a transparent pixel could not
 *    be told apart from "unchanged"). Every frame uses disposal 2 (restore to
 *    background = clear), so the canvas is empty before every frame; with optimize
 *    the frame is still cropped to the bounding box of its opaque pixels.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- helpers
  var LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

  function rgba32(r, g, b, a) {
    return LITTLE_ENDIAN
      ? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
      : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
  }
  var RGB_MASK = LITTLE_ENDIAN ? 0x00ffffff : 0xffffff00;

  function toU8(buf) {
    if (buf instanceof Uint8Array) return buf;
    if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
    if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    throw new TypeError('GifCodec: expected an ArrayBuffer');
  }

  function isGif(buf) {
    var u;
    try { u = toU8(buf); } catch (e) { return false; }
    if (u.length < 6) return false;
    return u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x38 &&
      (u[4] === 0x37 || u[4] === 0x39) && u[5] === 0x61;
  }

  // ---------------------------------------------------------------- decoder
  var lzwPrefix = new Int16Array(4096);
  var lzwSuffix = new Uint8Array(4096);
  var lzwStack = new Uint8Array(4097);

  // Decodes into out (length >= pixelCount). Returns number of pixels written.
  function lzwDecode(data, minCodeSize, out, pixelCount) {
    var clear = 1 << minCodeSize, eoi = clear + 1;
    var codeSize = minCodeSize + 1, codeMask = (1 << codeSize) - 1, avail = clear + 2;
    var old = -1, first = 0, datum = 0, bits = 0, pos = 0, op = 0, top = 0;
    var prefix = lzwPrefix, suffix = lzwSuffix, stack = lzwStack, len = data.length;
    for (var i = 0; i < clear; i++) { prefix[i] = 0; suffix[i] = i; }
    while (op < pixelCount) {
      while (bits < codeSize) {
        if (pos >= len) return op;
        datum |= data[pos++] << bits;
        bits += 8;
      }
      var code = datum & codeMask;
      datum >>>= codeSize;
      bits -= codeSize;
      if (code === clear) {
        codeSize = minCodeSize + 1; codeMask = (1 << codeSize) - 1; avail = clear + 2; old = -1;
        continue;
      }
      if (code === eoi) return op;
      if (old === -1) {
        if (code >= clear) return op; // corrupt
        out[op++] = code; old = code; first = code;
        continue;
      }
      var inCode = code;
      if (code >= avail) {
        if (code > avail) return op; // corrupt
        stack[top++] = first;
        code = old;
      }
      while (code >= clear) {
        stack[top++] = suffix[code];
        code = prefix[code];
      }
      first = suffix[code];
      stack[top++] = first;
      if (avail < 4096) {
        prefix[avail] = old;
        suffix[avail] = first;
        avail++;
        if ((avail & codeMask) === 0 && avail < 4096) { codeSize++; codeMask += avail; }
      }
      old = inCode;
      while (top > 0 && op < pixelCount) out[op++] = stack[--top];
      top = 0;
    }
    return op;
  }

  var MAX_PIXEL_FRAMES = 600e6;

  function decode(buf) {
    var u8 = toU8(buf);
    if (!isGif(u8)) throw new Error('Not a GIF file (missing GIF87a/GIF89a header)');
    var len = u8.length;
    if (len < 13) throw new Error('GIF file is truncated (no logical screen descriptor)');

    function need(n) { if (pos + n > len) throw new Error('unexpected end of file'); }
    function readPalette(n) {
      var pal = new Uint32Array(256);
      pal.fill(rgba32(0, 0, 0, 255));
      var avail = Math.min(n, Math.floor((len - pos) / 3));
      for (var i = 0; i < avail; i++) {
        var p = pos + i * 3;
        pal[i] = rgba32(u8[p], u8[p + 1], u8[p + 2], 255);
      }
      pos += n * 3;
      if (pos > len) { pos = len; }
      return pal;
    }

    var W = u8[6] | (u8[7] << 8);
    var H = u8[8] | (u8[9] << 8);
    var lsdPacked = u8[10];
    var pos = 13;
    var gct = null;
    if (lsdPacked & 0x80) gct = readPalette(2 << (lsdPacked & 7));

    var frames = [];
    var loopCount = null;
    var truncated = false;
    var error = null;
    var gce = null;
    var canvas = null, c32 = null, saved = null;
    var prevDisposal = 0, prevRect = null;
    var indexBuf = new Uint8Array(0);
    var defaultPal = null;

    try {
      while (pos < len) {
        var b = u8[pos++];
        if (b === 0x3b) break; // trailer
        if (b === 0x00) continue; // stray padding
        if (b === 0x21) {
          need(1);
          var label = u8[pos++];
          var firstBlock = true, isNetscape = false;
          for (;;) {
            need(1);
            var n = u8[pos++];
            if (n === 0) break;
            need(n);
            if (label === 0xf9 && firstBlock && n >= 4) {
              var gp = u8[pos];
              gce = {
                disposal: (gp >> 2) & 7,
                transIndex: (gp & 1) ? u8[pos + 3] : -1,
                delay: u8[pos + 1] | (u8[pos + 2] << 8)
              };
            } else if (label === 0xff) {
              if (firstBlock) {
                var id = '';
                for (var k = 0; k < Math.min(n, 11); k++) id += String.fromCharCode(u8[pos + k]);
                isNetscape = id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0';
              } else if (isNetscape && n >= 3 && u8[pos] === 1) {
                loopCount = u8[pos + 1] | (u8[pos + 2] << 8);
              }
            }
            firstBlock = false;
            pos += n;
          }
          continue;
        }
        if (b !== 0x2c) { if (frames.length) truncated = true; break; } // unknown block: corrupt

        // ---- image descriptor
        need(9);
        var fx = u8[pos] | (u8[pos + 1] << 8);
        var fy = u8[pos + 2] | (u8[pos + 3] << 8);
        var fw = u8[pos + 4] | (u8[pos + 5] << 8);
        var fh = u8[pos + 6] | (u8[pos + 7] << 8);
        var ip = u8[pos + 8];
        pos += 9;
        var pal = gct;
        if (ip & 0x80) pal = readPalette(2 << (ip & 7));
        if (!pal) {
          if (!defaultPal) {
            defaultPal = new Uint32Array(256);
            for (var g = 0; g < 256; g++) defaultPal[g] = rgba32(g, g, g, 255);
          }
          pal = defaultPal;
        }
        var interlaced = (ip & 0x40) !== 0;
        need(1);
        var minCode = u8[pos++];
        if (minCode < 1 || minCode > 11) throw new Error('invalid LZW minimum code size ' + minCode);

        // gather sub-blocks (tolerant of truncation)
        var p = pos, total = 0, ended = false;
        while (p < len) {
          var bl = u8[p];
          if (bl === 0) { p++; ended = true; break; }
          if (p + 1 + bl > len) { total += len - p - 1; p = len; break; }
          total += bl; p += bl + 1;
        }
        var data = new Uint8Array(total);
        var q = pos, o = 0;
        while (o < total) {
          var bl2 = u8[q];
          var take = Math.min(bl2, total - o);
          data.set(u8.subarray(q + 1, q + 1 + take), o);
          o += take; q += bl2 + 1;
        }
        pos = p;

        if (!canvas) {
          if (!W || !H) { W = W || fx + fw; H = H || fy + fh; }
          if (!W || !H) throw new Error('GIF has zero size');
          canvas = new Uint8ClampedArray(W * H * 4);
          c32 = new Uint32Array(canvas.buffer);
        }
        if ((frames.length + 1) * W * H > MAX_PIXEL_FRAMES) { truncated = true; break; }

        var disposal = gce ? gce.disposal : 0;
        var transIndex = gce ? gce.transIndex : -1;
        var delay = gce ? gce.delay * 10 : 0;
        if (delay <= 10) delay = 100;
        gce = null;

        // dispose previous frame
        if (prevDisposal === 2 && prevRect) {
          var x0 = prevRect[0], y0 = prevRect[1];
          var x1 = Math.min(W, x0 + prevRect[2]), y1 = Math.min(H, y0 + prevRect[3]);
          for (var yy = y0; yy < y1; yy++) c32.fill(0, yy * W + x0, yy * W + x1);
        } else if (prevDisposal === 3 && saved) {
          canvas.set(saved);
        }
        if (disposal === 3) {
          if (!saved) saved = new Uint8ClampedArray(canvas.length);
          saved.set(canvas);
        }

        // LZW
        var count = fw * fh;
        if (indexBuf.length < count) indexBuf = new Uint8Array(count);
        var got = count ? lzwDecode(data, minCode, indexBuf, count) : 0;

        // draw
        if (got > 0) {
          var rowMap = null;
          if (interlaced) {
            rowMap = new Int32Array(fh);
            var r = 0, passes = [[0, 8], [4, 8], [2, 4], [1, 2]];
            for (var ps = 0; ps < 4; ps++) {
              for (var ry = passes[ps][0]; ry < fh; ry += passes[ps][1]) rowMap[r++] = ry;
            }
          }
          var xEnd = Math.min(fw, W - fx);
          for (var row = 0; row < fh; row++) {
            var src = row * fw;
            if (src >= got) break;
            var y = fy + (rowMap ? rowMap[row] : row);
            if (y >= H || xEnd <= 0) continue;
            var dst = y * W + fx;
            var lim = Math.min(xEnd, got - src);
            if (transIndex < 0) {
              for (var x = 0; x < lim; x++) c32[dst + x] = pal[indexBuf[src + x]];
            } else {
              for (var x2 = 0; x2 < lim; x2++) {
                var idx = indexBuf[src + x2];
                if (idx !== transIndex) c32[dst + x2] = pal[idx];
              }
            }
          }
          frames.push({ imageData: new ImageData(canvas.slice(), W, H), delay: delay });
        }
        prevDisposal = disposal;
        prevRect = [fx, fy, fw, fh];
        if (!ended) { truncated = true; break; }
      }
    } catch (e) {
      error = e;
      truncated = true;
    }

    if (!frames.length) {
      throw new Error(error ? 'Could not decode GIF: ' + error.message : 'GIF contains no decodable frames');
    }
    var result = { width: W, height: H, loopCount: loopCount, frames: frames };
    if (truncated) result.truncated = true;
    return result;
  }

  // ---------------------------------------------------------------- encoder: byte writer
  function ByteWriter() {
    this.buf = new Uint8Array(1 << 20);
    this.len = 0;
  }
  ByteWriter.prototype.ensure = function (n) {
    if (this.len + n <= this.buf.length) return;
    var size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    var nb = new Uint8Array(size);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  };
  ByteWriter.prototype.byte = function (b) { this.ensure(1); this.buf[this.len++] = b; };
  ByteWriter.prototype.u16 = function (v) { this.ensure(2); this.buf[this.len++] = v & 255; this.buf[this.len++] = (v >> 8) & 255; };
  ByteWriter.prototype.str = function (s) { for (var i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); };
  ByteWriter.prototype.bytes = function (arr, start, end) {
    this.ensure(end - start);
    this.buf.set(arr.subarray(start, end), this.len);
    this.len += end - start;
  };

  // ---------------------------------------------------------------- encoder: LZW
  var HSIZE = 5003;
  var lzwHtab = new Int32Array(HSIZE);
  var lzwCodetab = new Int32Array(HSIZE);
  var lzwAccum = new Uint8Array(256);

  function lzwEncode(pixels, len, minCodeSize, w) {
    w.byte(minCodeSize);
    var initBits = minCodeSize + 1;
    var clearCode = 1 << minCodeSize, eofCode = clearCode + 1;
    var nBits = initBits, maxcode = (1 << nBits) - 1, freeEnt = clearCode + 2, clearFlg = false;
    var htab = lzwHtab, codetab = lzwCodetab, accum = lzwAccum;
    var aCount = 0, cur = 0, curBits = 0;

    function flush() {
      if (aCount > 0) { w.byte(aCount); w.bytes(accum, 0, aCount); aCount = 0; }
    }
    function output(code) {
      cur |= code << curBits;
      curBits += nBits;
      while (curBits >= 8) {
        accum[aCount++] = cur & 255;
        if (aCount >= 254) flush();
        cur >>= 8; curBits -= 8;
      }
      if (freeEnt > maxcode || clearFlg) {
        if (clearFlg) { nBits = initBits; maxcode = (1 << nBits) - 1; clearFlg = false; }
        else { nBits++; maxcode = nBits === 12 ? 4096 : (1 << nBits) - 1; }
      }
      if (code === eofCode) {
        while (curBits > 0) {
          accum[aCount++] = cur & 255;
          if (aCount >= 254) flush();
          cur >>= 8; curBits -= 8;
        }
        flush();
      }
    }

    var hshift = 0;
    for (var fc = HSIZE; fc < 65536; fc *= 2) hshift++;
    hshift = 8 - hshift;

    htab.fill(-1);
    output(clearCode);
    var ent = pixels[0];
    outer:
    for (var i = 1; i < len; i++) {
      var c = pixels[i];
      var fcode = (c << 12) + ent;
      var h = (c << hshift) ^ ent;
      if (htab[h] === fcode) { ent = codetab[h]; continue; }
      if (htab[h] >= 0) {
        var disp = HSIZE - h;
        if (h === 0) disp = 1;
        do {
          if ((h -= disp) < 0) h += HSIZE;
          if (htab[h] === fcode) { ent = codetab[h]; continue outer; }
        } while (htab[h] >= 0);
      }
      output(ent);
      ent = c;
      if (freeEnt < 4096) {
        codetab[h] = freeEnt++;
        htab[h] = fcode;
      } else {
        htab.fill(-1);
        freeEnt = clearCode + 2;
        clearFlg = true;
        output(clearCode);
      }
    }
    output(ent);
    output(eofCode);
    w.byte(0);
  }

  // ---------------------------------------------------------------- encoder: colour collection + quantization
  function ColorCollector(maxColors) {
    this.maxColors = maxColors;
    this.counts = new Float64Array(32768);
    this.sr = new Float64Array(32768);
    this.sg = new Float64Array(32768);
    this.sb = new Float64Array(32768);
    this.keys = new Int32Array(1024).fill(-1);
    this.vals = new Int16Array(1024);
    this.exactCount = 0;
    this.overflow = false;
  }
  ColorCollector.prototype.reset = function (maxColors) {
    this.maxColors = maxColors;
    this.counts.fill(0); this.sr.fill(0); this.sg.fill(0); this.sb.fill(0);
    this.keys.fill(-1);
    this.exactCount = 0;
    this.overflow = false;
  };
  ColorCollector.prototype.add = function (rgb, n) {
    var r = rgb >> 16, g = (rgb >> 8) & 255, b = rgb & 255;
    var k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    this.counts[k] += n; this.sr[k] += r * n; this.sg[k] += g * n; this.sb[k] += b * n;
    if (this.overflow) return;
    var keys = this.keys;
    var h = Math.imul(rgb, 0x9e3779b1) >>> 22;
    while (keys[h] !== -1) {
      if (keys[h] === rgb) return;
      h = (h + 1) & 1023;
    }
    if (this.exactCount >= this.maxColors) { this.overflow = true; return; }
    keys[h] = rgb;
    this.vals[h] = this.exactCount++;
  };
  // collect pixels with state=1 inside box
  ColorCollector.prototype.collect = function (d, state, box, W) {
    var last = -1, run = 0;
    for (var y = box.y; y < box.y + box.h; y++) {
      var i = y * W + box.x, iEnd = i + box.w;
      for (; i < iEnd; i++) {
        if (!state[i]) continue;
        var p = i << 2;
        var rgb = (d[p] << 16) | (d[p + 1] << 8) | d[p + 2];
        if (rgb === last) { run++; continue; }
        if (run) this.add(last, run);
        last = rgb; run = 1;
      }
    }
    if (run) this.add(last, run);
  };

  function Quantizer(palette, count, keys, vals) {
    this.palette = palette; // Uint8Array, 3 * count
    this.count = count;
    this.keys = keys; // exact lookup (or null)
    this.vals = vals;
    this.exact = !!keys;
    this.cache = new Int16Array(32768).fill(-1);
  }
  Quantizer.prototype.nearest = function (r, g, b) {
    var pal = this.palette, best = 0, bestD = Infinity;
    for (var i = 0, n = this.count; i < n; i++) {
      var dr = pal[i * 3] - r, dg = pal[i * 3 + 1] - g, db = pal[i * 3 + 2] - b;
      var dd = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (dd < bestD) { bestD = dd; best = i; if (dd === 0) break; }
    }
    return best;
  };
  Quantizer.prototype.map = function (r, g, b) {
    var keys = this.keys;
    if (keys) {
      var rgb = (r << 16) | (g << 8) | b;
      var h = Math.imul(rgb, 0x9e3779b1) >>> 22;
      var kk;
      while ((kk = keys[h]) !== -1) {
        if (kk === rgb) return this.vals[h];
        h = (h + 1) & 1023;
      }
    }
    var k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    var v = this.cache[k];
    if (v < 0) { v = this.nearest(r, g, b); this.cache[k] = v; }
    return v;
  };

  function buildQuantizer(col) {
    var i, n;
    if (!col.overflow) {
      n = col.exactCount;
      var pal = new Uint8Array(Math.max(1, n) * 3);
      var keys = new Int32Array(col.keys), vals = new Int16Array(col.vals);
      for (i = 0; i < 1024; i++) {
        if (keys[i] !== -1) {
          var v = vals[i], rgb = keys[i];
          pal[v * 3] = rgb >> 16; pal[v * 3 + 1] = (rgb >> 8) & 255; pal[v * 3 + 2] = rgb & 255;
        }
      }
      return new Quantizer(pal, n, keys, vals);
    }
    // median cut on the 5-bit histogram (bins hold exact 8-bit sums)
    var counts = col.counts, binIds = [];
    for (i = 0; i < 32768; i++) if (counts[i] > 0) binIds.push(i);
    n = binIds.length;
    var br = new Float64Array(n), bg = new Float64Array(n), bb = new Float64Array(n), bc = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var k = binIds[i], c = counts[k];
      bc[i] = c; br[i] = col.sr[k] / c; bg[i] = col.sg[k] / c; bb[i] = col.sb[k] / c;
    }
    var axes = [br, bg, bb];
    var ids = new Int32Array(n);
    for (i = 0; i < n; i++) ids[i] = i;

    function makeBox(s, e) {
      var sc = 0, s1 = [0, 0, 0], s2 = [0, 0, 0];
      for (var j = s; j < e; j++) {
        var id = ids[j], w = bc[id];
        sc += w;
        for (var a = 0; a < 3; a++) { var x = axes[a][id]; s1[a] += w * x; s2[a] += w * x * x; }
      }
      var sse = 0, axis = 0, best = -1;
      for (var a2 = 0; a2 < 3; a2++) {
        var e2 = s2[a2] - s1[a2] * s1[a2] / sc;
        sse += e2;
        if (e2 > best) { best = e2; axis = a2; }
      }
      return { s: s, e: e, count: sc, sse: sse, axis: axis, mean: [s1[0] / sc, s1[1] / sc, s1[2] / sc] };
    }

    var boxes = [makeBox(0, n)];
    while (boxes.length < col.maxColors) {
      var bi = -1, bs = 0;
      for (i = 0; i < boxes.length; i++) {
        if (boxes[i].e - boxes[i].s > 1 && boxes[i].sse > bs) { bs = boxes[i].sse; bi = i; }
      }
      if (bi < 0) break;
      var box = boxes[bi], av = axes[box.axis];
      ids.subarray(box.s, box.e).sort(function (a, b) { return av[a] - av[b]; });
      var half = box.count / 2, acc = 0, m = box.s;
      for (; m < box.e - 1; m++) { acc += bc[ids[m]]; if (acc >= half) break; }
      m++;
      if (m <= box.s) m = box.s + 1;
      if (m >= box.e) m = box.e - 1;
      boxes.splice(bi, 1, makeBox(box.s, m), makeBox(m, box.e));
    }
    var pal2 = new Uint8Array(boxes.length * 3);
    for (i = 0; i < boxes.length; i++) {
      pal2[i * 3] = Math.round(boxes[i].mean[0]);
      pal2[i * 3 + 1] = Math.round(boxes[i].mean[1]);
      pal2[i * 3 + 2] = Math.round(boxes[i].mean[2]);
    }
    return new Quantizer(pal2, boxes.length, null, null);
  }

  // ---------------------------------------------------------------- encoder: frame helpers
  function abortError() {
    try { return new DOMException('GIF encoding aborted', 'AbortError'); }
    catch (e) { var err = new Error('GIF encoding aborted'); err.name = 'AbortError'; return err; }
  }

  function imageSize(img) {
    if (!img) throw new Error('GifCodec.encode: frame without image');
    var w = img.width || img.naturalWidth || img.videoWidth || 0;
    var h = img.height || img.naturalHeight || img.videoHeight || 0;
    return [w, h];
  }

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function FrameReader(W, H) {
    this.W = W; this.H = H;
    this.scratch = null; this.sctx = null;
  }
  FrameReader.prototype.read = function (img) {
    var W = this.W, H = this.H;
    var isID = typeof ImageData !== 'undefined' && img instanceof ImageData;
    if (isID && img.width === W && img.height === H) return img.data;
    if (!isID && img.width === W && img.height === H && typeof img.getContext === 'function') {
      var ctx = null;
      try { ctx = img.getContext('2d'); } catch (e) { ctx = null; }
      if (ctx) return ctx.getImageData(0, 0, W, H).data;
    }
    if (!this.scratch) {
      this.scratch = makeCanvas(W, H);
      this.sctx = this.scratch.getContext('2d', { willReadFrequently: true });
    }
    var sc = this.sctx;
    sc.clearRect(0, 0, W, H);
    sc.imageSmoothingEnabled = true;
    var source = img;
    if (isID) {
      source = makeCanvas(img.width, img.height);
      source.getContext('2d').putImageData(img, 0, 0);
    }
    sc.drawImage(source, 0, 0, W, H);
    return sc.getImageData(0, 0, W, H).data;
  };

  // Fills state (1 = pixel is encoded, 0 = transparent index) and returns the bounding box
  // of encoded pixels, or null if there are none.
  // mode: 'full' | 'alpha' | 'diff'
  function computeState(d8, prev8, W, H, mode, state) {
    if (mode === 'full') { state.fill(1); return { x: 0, y: 0, w: W, h: H }; }
    var cur = new Uint32Array(d8.buffer, d8.byteOffset, W * H);
    var prev = prev8 ? new Uint32Array(prev8.buffer, prev8.byteOffset, W * H) : null;
    var minX = W, maxX = -1, minY = H, maxY = -1;
    for (var y = 0; y < H; y++) {
      var base = y * W, rowMin = -1, rowMax = -1;
      for (var x = 0; x < W; x++) {
        var i = base + x, s;
        if (mode === 'alpha') s = d8[(i << 2) + 3] >= 128 ? 1 : 0;
        else s = ((cur[i] ^ prev[i]) & RGB_MASK) !== 0 ? 1 : 0;
        state[i] = s;
        if (s) { if (rowMin < 0) rowMin = x; rowMax = x; }
      }
      if (rowMin >= 0) {
        if (rowMin < minX) minX = rowMin;
        if (rowMax > maxX) maxX = rowMax;
        if (y < minY) minY = y;
        maxY = y;
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  function mapBox(d, state, box, W, q, transIdx, dither, out) {
    var bw = box.w, bh = box.h, o = 0, x, y, i, p;
    if (!dither || q.exact) {
      var last = -1, lastIdx = 0;
      for (y = 0; y < bh; y++) {
        i = (box.y + y) * W + box.x;
        for (x = 0; x < bw; x++, i++) {
          if (!state[i]) { out[o++] = transIdx; continue; }
          p = i << 2;
          var rgb = (d[p] << 16) | (d[p + 1] << 8) | d[p + 2];
          if (rgb !== last) { last = rgb; lastIdx = q.map(d[p], d[p + 1], d[p + 2]); }
          out[o++] = lastIdx;
        }
      }
      return;
    }
    // Floyd-Steinberg
    var pal = q.palette;
    var cur = new Float32Array((bw + 2) * 3), next = new Float32Array((bw + 2) * 3), tmp;
    for (y = 0; y < bh; y++) {
      i = (box.y + y) * W + box.x;
      next.fill(0);
      for (x = 0; x < bw; x++, i++) {
        if (!state[i]) { out[o++] = transIdx; continue; }
        p = i << 2;
        var e = (x + 1) * 3;
        var r = d[p] + cur[e], g = d[p + 1] + cur[e + 1], b = d[p + 2] + cur[e + 2];
        r = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
        g = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
        b = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
        var idx = q.map(r, g, b);
        out[o++] = idx;
        var er = r - pal[idx * 3], eg = g - pal[idx * 3 + 1], eb = b - pal[idx * 3 + 2];
        cur[e + 3] += er * 0.4375; cur[e + 4] += eg * 0.4375; cur[e + 5] += eb * 0.4375;
        next[e - 3] += er * 0.1875; next[e - 2] += eg * 0.1875; next[e - 1] += eb * 0.1875;
        next[e] += er * 0.3125; next[e + 1] += eg * 0.3125; next[e + 2] += eb * 0.3125;
        next[e + 3] += er * 0.0625; next[e + 4] += eg * 0.0625; next[e + 5] += eb * 0.0625;
      }
      tmp = cur; cur = next; next = tmp;
    }
  }

  function tableBits(n) {
    var bits = 1;
    while ((1 << bits) < n) bits++;
    return bits;
  }

  function writePalette(w, q, bits) {
    var size = 1 << bits;
    w.ensure(size * 3);
    for (var i = 0; i < size; i++) {
      if (i < q.count) {
        w.buf[w.len++] = q.palette[i * 3];
        w.buf[w.len++] = q.palette[i * 3 + 1];
        w.buf[w.len++] = q.palette[i * 3 + 2];
      } else {
        w.buf[w.len++] = 0; w.buf[w.len++] = 0; w.buf[w.len++] = 0;
      }
    }
  }

  function yieldToLoop() { return new Promise(function (r) { setTimeout(r, 0); }); }

  async function encode(frames, opts) {
    opts = opts || {};
    if (!frames || !frames.length) throw new Error('GifCodec.encode: no frames');
    var loop = opts.loop == null ? 0 : Math.floor(opts.loop);
    var colors = Math.max(2, Math.min(256, Math.floor(opts.colors || 256)));
    var dither = !!opts.dither;
    var useGlobal = !!opts.globalPalette;
    var transparent = !!opts.transparent;
    var optimize = opts.optimize !== false;
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    var signal = opts.signal || null;

    function checkAbort() { if (signal && signal.aborted) throw abortError(); }
    function progress(f) { if (onProgress) { try { onProgress(Math.min(1, Math.max(0, f))); } catch (e) { /* ignore */ } } }

    checkAbort();
    var size = imageSize(frames[0].image);
    var W = size[0], H = size[1];
    if (W < 1 || H < 1) throw new Error('GifCodec.encode: invalid frame size');
    if (W > 65535 || H > 65535) throw new Error('GifCodec.encode: frame too large for GIF');

    var N = frames.length, P = W * H;
    var reader = new FrameReader(W, H);
    var state = new Uint8Array(P);
    var indices = new Uint8Array(P);
    var col = new ColorCollector(colors);
    var reserveG = transparent || (optimize && N > 1);
    var disposal = transparent ? 2 : 1;

    function modeFor(i) {
      if (transparent) return optimize ? 'alpha' : 'alpha-full';
      return optimize && i > 0 ? 'diff' : 'full';
    }
    function frameState(d, prev, i) {
      var m = modeFor(i);
      if (m === 'alpha-full') {
        // transparent without cropping: full-size frame, alpha decides transparency
        computeState(d, null, W, H, 'alpha', state);
        return { x: 0, y: 0, w: W, h: H };
      }
      return computeState(d, prev, W, H, m, state);
    }

    var globalQ = null;
    var encodeStart = 0;
    if (useGlobal) {
      encodeStart = 0.3;
      col.reset(colors - (reserveG ? 1 : 0));
      var prevG = null;
      for (var gi = 0; gi < N; gi++) {
        checkAbort();
        var dg = reader.read(frames[gi].image);
        var boxG = frameState(dg, prevG, gi);
        if (boxG) col.collect(dg, state, boxG, W);
        prevG = dg;
        progress(encodeStart * (gi + 1) / N);
        await yieldToLoop();
      }
      checkAbort();
      globalQ = buildQuantizer(col);
    }

    var w = new ByteWriter();
    w.str('GIF89a');
    w.u16(W); w.u16(H);
    var gBits = 0;
    if (globalQ) {
      gBits = tableBits(globalQ.count + (reserveG ? 1 : 0));
      w.byte(0x80 | 0x70 | (gBits - 1));
    } else {
      w.byte(0x70);
    }
    w.byte(0); w.byte(0);
    if (globalQ) writePalette(w, globalQ, gBits);
    if (loop >= 0 && N > 1 || loop > 0) {
      w.byte(0x21); w.byte(0xff); w.byte(11); w.str('NETSCAPE2.0');
      w.byte(3); w.byte(1); w.u16(Math.min(65535, loop)); w.byte(0);
    }

    var prev = null;
    for (var i = 0; i < N; i++) {
      checkAbort();
      var d = reader.read(frames[i].image);
      var box = frameState(d, prev, i);
      var reserve = globalQ ? reserveG : (transparent || (optimize && i > 0));
      var q;
      if (globalQ) {
        q = globalQ;
      } else {
        col.reset(colors - (reserve ? 1 : 0));
        if (box) col.collect(d, state, box, W);
        q = buildQuantizer(col);
      }
      var transIdx = reserve ? q.count : -1;
      var empty = !box;
      if (empty) box = { x: 0, y: 0, w: 1, h: 1 };
      var pixCount = box.w * box.h;
      if (empty) indices[0] = transIdx;
      else mapBox(d, state, box, W, q, transIdx, dither, indices);

      var cs = Math.round((frames[i].delay == null ? 100 : +frames[i].delay) / 10);
      if (!(cs >= 2)) cs = 2;
      if (cs > 65535) cs = 65535;

      // graphic control extension
      w.byte(0x21); w.byte(0xf9); w.byte(4);
      w.byte((disposal << 2) | (reserve ? 1 : 0));
      w.u16(cs);
      w.byte(reserve ? transIdx : 0);
      w.byte(0);
      // image descriptor
      w.byte(0x2c);
      w.u16(box.x); w.u16(box.y); w.u16(box.w); w.u16(box.h);
      var bits;
      if (globalQ) {
        bits = gBits;
        w.byte(0);
      } else {
        bits = tableBits(q.count + (reserve ? 1 : 0));
        w.byte(0x80 | (bits - 1));
        writePalette(w, q, bits);
      }
      lzwEncode(indices, pixCount, Math.max(2, bits), w);

      prev = d;
      progress(encodeStart + (1 - encodeStart) * (i + 1) / N);
      await yieldToLoop();
    }
    checkAbort();
    w.byte(0x3b);
    return new Blob([w.buf.subarray(0, w.len)], { type: 'image/gif' });
  }

  window.GifCodec = { isGif: isGif, decode: decode, encode: encode };
})();
