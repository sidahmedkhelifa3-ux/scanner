/* ============================================================
   Pyjama Dz Tag Scanner — decode engine
   ------------------------------------------------------------
   WHAT THIS CAN AND CANNOT DO — read this before tuning it.

   A barcode is only readable if its narrowest bar lands on at
   least ~2 camera pixels, and comfortably at 3. EAN-13 is 95
   modules wide, so the barcode has to span roughly 250-300
   pixels in the captured frame. Past that distance the detail
   is not dim or noisy — it is not in the image at all, and no
   amount of processing invents it back. The levers that
   genuinely extend range are therefore optical, and both are
   used here: capture at the highest resolution the camera
   offers, and let the user spend those pixels on a smaller
   patch of the world with the zoom buttons.

   Zoom is deliberately MANUAL. The camera never changes it on
   its own: a viewfinder that moves while you are lining up a
   tag is worse than a short reach.

   Occlusion is a harder wall. EAN-13, Code 39 and ITF carry NO
   error correction — the check digit detects a misread, it
   cannot rebuild missing bars. Cover part of the bar region and
   the number is mathematically unrecoverable. (QR and DataMatrix
   have Reed-Solomon and survive ~30% loss; 1D retail codes do
   not.) What this engine can do is find a tag that is small,
   off-centre, tilted or upside down — which is usually what
   "hidden" turns out to mean in practice.

   HOW IT FINDS THINGS
   A scan PLAN covers the frame at several scales and angles:
   the centre band, the whole frame, four overlapping quadrants
   at 2x magnification, a 3x centre close-up, and tilted passes.
   Each frame works through the plan under a time BUDGET and
   resumes where it stopped, so coverage is wide without the
   frame rate collapsing. A pass that succeeds is remembered and
   tried first next time.
   ============================================================ */

(function(global){
  "use strict";

  var RETAIL = ["EAN_13", "EAN_8", "UPC_A", "UPC_E"];
  /* Widening adds CODE_128 and CODE_39 only. ITF and CODABAR are left
     OUT on purpose: neither carries a usable check digit, both decode
     noise into plausible numbers, and clothing tags do not use them.
     Enable them explicitly with FastDecoder.create(video, {risky:true})
     if a supplier's labels ever need it. */
  var EXTRA  = ["CODE_128", "CODE_39"];
  var RISKY  = ["ITF", "CODABAR"];

  var TARGET_PX    = 760;   // decode width; more than this buys nothing
  var MAX_UPSCALE  = 2.2;   // lets the tight passes magnify
  var FRAME_BUDGET = 30;    // ms of decoding per frame
  var WIDEN_MS     = 3500;  // no read this long -> enable every format
  var HINT_MS      = 1600;
  var QUIET_MS     = 1500;
  var REFOCUS_GAP  = 1400;  // ms between automatic refocus attempts
  var DARK_LUMA    = 46, DIM_LUMA = 70, FLAT_EDGE = 9;

  /* Normalised windows on the frame. Order matters: cheap and
     most-likely first, magnified and exotic last. */
  function buildPlan(){
    var P = [];
    // 1. the centre band — a tag held up to the camera
    P.push({ x:0.08, y:0.30, w:0.84, h:0.40, rot:0,  tag:"centre" });
    P.push({ x:0.08, y:0.30, w:0.84, h:0.40, rot:90, tag:"centre ⟲" });
    // 2. the whole frame — a tag anywhere, if it is big enough
    P.push({ x:0.00, y:0.00, w:1.00, h:1.00, rot:0,  tag:"frame" });
    P.push({ x:0.00, y:0.00, w:1.00, h:1.00, rot:90, tag:"frame ⟲" });
    // 3. four overlapping quadrants at ~2x — a small tag off to one side
    var q = 0.56, step = 1 - q;
    for(var gy = 0; gy < 2; gy++){
      for(var gx = 0; gx < 2; gx++){
        P.push({ x: gx*step, y: gy*step, w:q, h:q, rot:0,  tag:"tile" });
        P.push({ x: gx*step, y: gy*step, w:q, h:q, rot:90, tag:"tile ⟲" });
      }
    }
    // 4. a 3x centre close-up — a distant tag
    P.push({ x:0.34, y:0.36, w:0.32, h:0.28, rot:0,  tag:"reach" });
    P.push({ x:0.34, y:0.36, w:0.32, h:0.28, rot:90, tag:"reach ⟲" });
    // 5. tilted — a tag lying at an angle
    P.push({ x:0.10, y:0.25, w:0.80, h:0.50, rot:28,  tag:"tilt" });
    P.push({ x:0.10, y:0.25, w:0.80, h:0.50, rot:-28, tag:"tilt" });
    return P;
  }

  function FastDecoder(video, opts){
    this.allowRisky = !!(opts && opts.risky);
    this.video   = video;
    this.canvas  = document.createElement("canvas");
    this.ctx     = this.canvas.getContext("2d", { willReadFrequently: true });
    this.running = false;
    this.track   = null;

    this.plan    = buildPlan();
    this.cursor  = 0;
    this.bestPass = 0;        // the window that worked last time

    this.formats = RETAIL.slice();
    this.widened = false;
    this.lastHitAt = 0; this.startedAt = 0; this.frames = 0;
    this.lastHintAt = 0; this.lastHint = ""; this.torchAuto = false;
    this.zoom = null; this.zoomCaps = null;
    this.native = null; this.zxing = null; this.pending = null;
    this._probe = null; this._probeCtx = null; this._aim = null;
  }

  /* ---------- decoder back ends ---------- */

  FastDecoder.prototype._setupNative = function(){
    var self = this;
    if(!global.BarcodeDetector || !global.BarcodeDetector.getSupportedFormats){
      return Promise.resolve(false);
    }
    return global.BarcodeDetector.getSupportedFormats().then(function(supported){
      var want = self.formats.map(function(f){ return f.toLowerCase(); })
        .filter(function(f){ return supported.indexOf(f) > -1; });
      if(!want.length) return false;
      self.native = new global.BarcodeDetector({ formats: want });
      return true;
    }).catch(function(){ return false; });
  };

  FastDecoder.prototype._setupZxing = function(){
    if(!global.ZXing) return false;
    var Z = global.ZXing;
    try{
      var hints = new Map();
      hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, this.formats.map(function(f){
        return Z.BarcodeFormat[f];
      }));
      // TRY_HARDER stays off on video: the plan already covers the
      // rotations it would attempt, and more frames beats more effort.
      var reader = new Z.MultiFormatReader();
      reader.setHints(hints);
      var fastPath = typeof Z.HTMLCanvasElementLuminanceSource === "function" &&
                     typeof Z.BinaryBitmap === "function" &&
                     typeof Z.HybridBinarizer === "function" &&
                     typeof reader.decodeWithState === "function";
      this.zxing = fastPath
        ? { reader: reader, mode: "canvas" }
        : { reader: new Z.BrowserMultiFormatReader(hints), mode: "browser" };
      return true;
    }catch(e){ return false; }
  };

  FastDecoder.prototype._widen = function(){
    if(this.widened) return Promise.resolve();
    this.widened = true;
    this.formats = RETAIL.concat(EXTRA).concat(this.allowRisky ? RISKY : []);
    this.native = null; this.zxing = null;
    var self = this;
    return this._setupNative().then(function(){ self._setupZxing(); });
  };

  /* ---------- draw one window of the frame ---------- */

  FastDecoder.prototype._draw = function(p){
    var v = this.video, ctx = this.ctx, c = this.canvas;
    var vw = v.videoWidth, vh = v.videoHeight;

    var sw = Math.max(16, Math.round(vw * p.w));
    var sh = Math.max(16, Math.round(vh * p.h));
    var sx = Math.round(vw * p.x);
    var sy = Math.round(vh * p.y);

    var scale = Math.min(MAX_UPSCALE, TARGET_PX / sw);
    var dw = Math.max(80, Math.round(sw * scale));
    var dh = Math.max(40, Math.round(sh * scale));

    if(p.rot === 0){
      c.width = dw; c.height = dh;
      ctx.drawImage(v, sx, sy, sw, sh, 0, 0, dw, dh);
      return;
    }
    if(p.rot === 90){
      // a vertical tag becomes horizontal, the only way 1D readers scan
      c.width = dh; c.height = dw;
      ctx.save();
      ctx.translate(dh, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(v, sx, sy, sw, sh, 0, 0, dw, dh);
      ctx.restore();
      return;
    }
    // arbitrary angle: size the canvas to the rotated bounding box
    var rad = p.rot * Math.PI / 180;
    var ca = Math.abs(Math.cos(rad)), sa = Math.abs(Math.sin(rad));
    var bw = Math.round(dw * ca + dh * sa);
    var bh = Math.round(dw * sa + dh * ca);
    c.width = bw; c.height = bh;
    ctx.save();
    ctx.translate(bw / 2, bh / 2);
    ctx.rotate(rad);
    ctx.drawImage(v, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  };

  /* ---------- decode whatever is on the canvas ---------- */

  /* Map a box in CANVAS pixels back to normalised frame coordinates,
     undoing the crop, the scale and the rotation of the pass it came
     from. This is what lets the barcode act as a spatial anchor for
     OCR: without it, "near the barcode" has no meaning. */
  function mapBox(p, c, box){
    if(!box || !c.width || !c.height) return null;
    var nx, ny, nw, nh;
    if(p.rot === 0){
      nx = box.x / c.width;  ny = box.y / c.height;
      nw = box.w / c.width;  nh = box.h / c.height;
    } else if(p.rot === 90){
      // drawn with translate(dh,0) + rotate(90°): canvas(cx,cy) <- image(cy, dh-cx)
      nx = box.y / c.height;
      ny = 1 - (box.x + box.w) / c.width;
      nw = box.h / c.height;
      nh = box.w / c.width;
    } else {
      return { x: p.x, y: p.y, w: p.w, h: p.h, approx: true };   // tilted: use the window
    }
    return {
      x: p.x + nx * p.w,
      y: p.y + ny * p.h,
      w: nw * p.w,
      h: nh * p.h
    };
  }

  function pointsBox(points){
    if(!points || !points.length) return null;
    var xs = [], ys = [];
    for(var i = 0; i < points.length; i++){
      var pt = points[i];
      if(!pt) continue;
      var x = typeof pt.getX === "function" ? pt.getX() : pt.x;
      var y = typeof pt.getY === "function" ? pt.getY() : pt.y;
      if(typeof x === "number" && typeof y === "number"){ xs.push(x); ys.push(y); }
    }
    if(!xs.length) return null;
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    // 1D result points sit on the centre line: give the box real height
    var h = Math.max(y1 - y0, (x1 - x0) * 0.22);
    return { x: x0, y: y0 - (h - (y1 - y0)) / 2, w: x1 - x0, h: h };
  }

  FastDecoder.prototype._decode = function(pass){
    var self = this;
    if(this.native){
      return this.native.detect(this.canvas).then(function(res){
        if(res && res.length){
          var r0 = res[0];
          var bb = r0.boundingBox;
          var box = bb ? { x: bb.x, y: bb.y, w: bb.width, h: bb.height }
                       : pointsBox(r0.cornerPoints);
          return {
            text: r0.rawValue,
            format: (r0.format || "").toUpperCase(),
            box: mapBox(pass, self.canvas, box)
          };
        }
        return null;
      }).catch(function(){ return null; });
    }
    if(this.zxing){
      var Z = global.ZXing;
      try{
        if(this.zxing.mode === "canvas"){
          var src = new Z.HTMLCanvasElementLuminanceSource(this.canvas);
          var bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(src));
          var r = this.zxing.reader.decodeWithState(bmp);
          if(r) return Promise.resolve({
            text: r.getText(), format: fmtName(r),
            box: mapBox(pass, this.canvas, pointsBox(r.getResultPoints && r.getResultPoints()))
          });
        } else {
          var r2 = this.zxing.reader.decodeFromCanvas(this.canvas);
          if(r2) return Promise.resolve({
            text: r2.getText(), format: fmtName(r2),
            box: mapBox(pass, this.canvas, pointsBox(r2.getResultPoints && r2.getResultPoints()))
          });
        }
      }catch(e){ /* NotFound on most passes — the normal path */ }
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  };

  function fmtName(result){
    try{
      var v = result.getBarcodeFormat();
      for(var k in global.ZXing.BarcodeFormat){
        if(global.ZXing.BarcodeFormat[k] === v) return k;
      }
    }catch(e){}
    return "";
  }

  /* ---------- optical reach: the camera's own zoom ---------- */

  FastDecoder.prototype._readZoomCaps = function(){
    try{
      var caps = this.track && this.track.getCapabilities ? this.track.getCapabilities() : null;
      if(caps && caps.zoom && typeof caps.zoom.max === "number" && caps.zoom.max > caps.zoom.min){
        this.zoomCaps = { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 };
        var s = this.track.getSettings ? this.track.getSettings() : {};
        this.zoom = typeof s.zoom === "number" ? s.zoom : this.zoomCaps.min;
      }
    }catch(e){}
    return this.zoomCaps;
  };

  /* Where the barcode was last seen, in 0..1 frame coordinates, so a tap
     near the bars can snap exactly onto them. */
  FastDecoder.prototype.lastBox = function(){ return this._lastBox || null; };

  FastDecoder.prototype.zoomRange = function(){ return this.zoomCaps; };
  FastDecoder.prototype.getZoom   = function(){ return this.zoom; };

  /* A still for OCR. Given the barcode's box, crop a generous region
     AROUND it — the label — instead of the whole picture: fewer pixels
     for OCR to chew through, and nothing from the background to
     misread. The margin is deliberately wide and equal on all sides,
     because the reference may be printed above, below or beside the
     bars depending on the label. Returns the canvas plus the mapping
     needed to express OCR boxes in the same space as the barcode. */
  FastDecoder.prototype.capture = function(maxEdge, box){
    var v = this.video;
    if(!v || !v.videoWidth) return null;

    var vw = v.videoWidth, vh = v.videoHeight;
    var sx = 0, sy = 0, sw = vw, sh = vh;

    if(box && box.w > 0 && box.h > 0){
      // grow the barcode box into a label-sized region
      var padX = Math.max(box.w * 0.8, 0.18);
      var padY = Math.max(box.h * 3.2, 0.30);
      var x0 = Math.max(0, box.x - padX), x1 = Math.min(1, box.x + box.w + padX);
      var y0 = Math.max(0, box.y - padY), y1 = Math.min(1, box.y + box.h + padY);
      sx = Math.round(x0 * vw); sy = Math.round(y0 * vh);
      sw = Math.max(32, Math.round((x1 - x0) * vw));
      sh = Math.max(32, Math.round((y1 - y0) * vh));
    }

    var cap = maxEdge || 1400;
    var scale = Math.min(1, cap / Math.max(sw, sh));
    var c = document.createElement("canvas");
    c.width  = Math.max(1, Math.round(sw * scale));
    c.height = Math.max(1, Math.round(sh * scale));
    c.getContext("2d").drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);

    // where this crop sits in the full frame, so boxes can be compared
    c.__region = { x: sx / vw, y: sy / vh, w: sw / vw, h: sh / vh };
    return c;
  };

  /* Only ever called from the zoom buttons. Nothing in the engine
     changes zoom by itself — see the note at the top. */
  FastDecoder.prototype.setZoom = function(z){
    if(!this.track || !this.zoomCaps) return Promise.resolve(false);
    var caps = this.zoomCaps;
    z = Math.max(caps.min, Math.min(caps.max, z));
    var self = this;
    return this.track.applyConstraints({ advanced: [{ zoom: z }] }).then(function(){
      self.zoom = z;
      if(self.onZoom) self.onZoom(z, caps);
      return true;
    }).catch(function(){ return false; });
  };

  /* ---------- picture quality, for coaching and auto-torch ---------- */

  FastDecoder.prototype._measure = function(){
    var c = this.canvas, ctx = this.ctx, w = c.width, h = c.height;
    if(w < 8 || h < 8) return null;
    var strip;
    try{ strip = ctx.getImageData(0, Math.floor(h / 2), w, 1).data; }
    catch(e){ return null; }
    var sum = 0, edges = 0, prev = -1, n = 0;
    for(var x = 0; x < w; x++){
      var i = x * 4;
      var lum = strip[i] * 0.299 + strip[i+1] * 0.587 + strip[i+2] * 0.114;
      sum += lum; n++;
      if(prev >= 0) edges += Math.abs(lum - prev);
      prev = lum;
    }
    return { luma: sum / n, edge: edges / Math.max(1, n - 1) };
  };

  FastDecoder.prototype._coach = function(q){
    var now = performance.now();
    if(now - this.lastHitAt < QUIET_MS) return;
    if(now - this.lastHintAt < HINT_MS) return;
    if(!q) return;
    var msg = null;
    if(q.luma < DARK_LUMA)      msg = "Too dark to read the bars.";
    else if(q.luma > 232)       msg = "Glare on the tag — tilt it away from the light.";
    else if(q.edge < FLAT_EDGE) msg = "Bars look blurred — the tag may be too far to resolve. Move closer.";
    else if(q.luma < DIM_LUMA)  msg = "A bit dim. More light would speed this up.";
    if(msg && msg !== this.lastHint){
      this.lastHint = msg; this.lastHintAt = now;
      if(this.onHint) this.onHint(msg);
    }
  };

  FastDecoder.prototype._autoTorch = function(q){
    if(this.torchAuto || !this.track || !q) return;
    if(q.luma >= DARK_LUMA) return;
    if(performance.now() - this.startedAt < 900) return;
    var self = this;
    try{
      var caps = this.track.getCapabilities ? this.track.getCapabilities() : {};
      if(!caps || !caps.torch) return;
      this.track.applyConstraints({ advanced: [{ torch: true }] }).then(function(){
        self.torchAuto = true;
        if(self.onHint) self.onHint("Dark — torch on.");
        if(self.onTorch) self.onTorch(true);
      }).catch(function(){});
    }catch(e){}
  };

  /* Drive autofocus at a specific spot. Two things make a phone focus
     slowly on a tag: it hunts across the whole scene because nothing
     tells it WHERE to look, and continuous mode will happily sit on
     the background. Naming a point of interest and running a
     single-shot cycle there is what the camera app does when you tap.
     `point` is {x, y} in 0..1 of the frame; defaults to the centre. */
  FastDecoder.prototype.refocus = function(point, opts){
    var t = this.track;
    if(!t || !t.applyConstraints) return;
    var p = point || { x: 0.5, y: 0.5 };
    var hold = (opts && opts.hold) || 600;
    this._refocusAt = performance.now();
    // A deliberate tap owns the focus for a while: nothing automatic may
    // drag the lens off what the user just pointed at.
    if(opts && opts.manual){
      this._manualUntil = this._refocusAt + (opts.lock || 4000);
      this._aim = { x: p.x, y: p.y };
      this._aimAt_ = this._refocusAt;
    }
    try{
      var caps = t.getCapabilities ? t.getCapabilities() : {};
      var modes = caps.focusMode || [];
      var has = function(m){ return modes.indexOf(m) > -1; };

      var aim = {};
      if(caps.pointsOfInterest){
        aim.pointsOfInterest = [{ x: Math.max(0, Math.min(1, p.x)),
                                  y: Math.max(0, Math.min(1, p.y)) }];
      }
      if(!modes.length){
        // no focus control, but aiming may still be honoured
        if(aim.pointsOfInterest) t.applyConstraints({ advanced: [aim] }).catch(function(){});
        return;
      }

      if(has("single-shot")){
        var shot = { focusMode: "single-shot" };
        for(var k in aim) shot[k] = aim[k];
        t.applyConstraints({ advanced: [shot] }).then(function(){
          if(!has("continuous")) return;
          // hand back to continuous quickly — a long manual hold is what
          // made the old version feel sluggish on the next tag
          setTimeout(function(){
            var back = { focusMode: "continuous" };
            for(var k2 in aim) back[k2] = aim[k2];
            t.applyConstraints({ advanced: [back] }).catch(function(){});
          }, hold);
        }).catch(function(){});
        return;
      }

      if(has("continuous")){
        var cont = { focusMode: "continuous" };
        for(var k3 in aim) cont[k3] = aim[k3];
        t.applyConstraints({ advanced: [cont] }).catch(function(){});
      }
    }catch(e){}
  };

  /* ---------- find the BARCODE ----------
     Focusing on the middle of the frame is a guess. The barcode is the
     best thing to aim at, so the probe looks for what a barcode uniquely
     is: a dense run of regular light/dark alternations along a
     horizontal line. Printed text also has edges, but far fewer
     crossings per millimetre and much less regular ones, so counting
     CROSSINGS rather than raw contrast picks the bars over a bold price.

     The threshold is each ROW's own mean rather than a fixed level, so
     a shadow falling across half the tag does not wipe out the count.

     On probe size: 240x180 was chosen by measurement, not guesswork.
     Running the bars-versus-text and distant-barcode tests at 240, 480
     and 960 gave identical results, so the smallest is used — it is
     four times less work than 480 for no measured loss. If a real
     phone ever disagrees, raise it here and re-run the decoder tests. */
  var PROBE_W = 240, PROBE_H = 180, GRID = 3;
  var HYST = 6;          // luma slack, so sensor noise is not a crossing

  FastDecoder.prototype._busiestSpot = function(){
    var v = this.video;
    if(!v || !v.videoWidth) return null;
    if(!this._probe){
      this._probe = document.createElement("canvas");
      this._probe.width = PROBE_W;
      this._probe.height = PROBE_H;
      this._probeCtx = this._probe.getContext("2d", { willReadFrequently: true });
    }
    var c = this._probe, ctx = this._probeCtx, img;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    try{ img = ctx.getImageData(0, 0, c.width, c.height); }
    catch(e){ return null; }

    var d = img.data, W = c.width, H = c.height;
    var best = -1, bx = 0.5, by = 0.5;

    for(var gy = 0; gy < GRID; gy++){
      for(var gx = 0; gx < GRID; gx++){
        var x0 = Math.floor(gx * W / GRID), x1 = Math.floor((gx + 1) * W / GRID);
        var y0 = Math.floor(gy * H / GRID), y1 = Math.floor((gy + 1) * H / GRID);

        var crossings = 0, samples = 0, span = 0, rows = 0;

        for(var y = y0; y < y1; y += 2){            // every other row is plenty
          // a row's own mean is the threshold, so this works on a grey
          // label in shade as well as a white one in sun
          var sum = 0, n = 0, lo = 255, hi = 0, x, i, lum;
          for(x = x0; x < x1; x++){
            i = (y * W + x) * 4;
            lum = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
            sum += lum; n++;
            if(lum < lo) lo = lum;
            if(lum > hi) hi = lum;
          }
          if(!n) continue;
          var mean = sum / n;
          if(hi - lo < 30) { rows++; continue; }     // flat row: nothing here

          var above = null;
          for(x = x0; x < x1; x++){
            i = (y * W + x) * 4;
            lum = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
            if(above === null){ above = lum > mean; continue; }
            if(above && lum < mean - HYST){ above = false; crossings++; }
            else if(!above && lum > mean + HYST){ above = true; crossings++; }
          }
          samples += n; span += (hi - lo); rows++;
        }

        if(!samples) continue;
        // crossings per pixel is the barcode signature; contrast only
        // breaks ties between two equally striped cells
        var density = crossings / samples;
        var contrast = rows ? (span / rows) / 255 : 0;
        var score = density * (0.7 + 0.3 * contrast);

        if(score > best){ best = score; bx = (gx + 0.5) / GRID; by = (gy + 0.5) / GRID; }
      }
    }
    return best > 0 ? { x: bx, y: by, score: best } : null;
  };

  /* Point the camera at something, but only when it is worth the call:
     a lens driven every frame never settles. */
  FastDecoder.prototype._aimAt = function(point, force){
    if(!point) return;
    var now = performance.now();
    if(now < (this._manualUntil || 0)) return;     // the user's tap wins
    var last = this._aim;
    if(!force && last &&
       Math.abs(last.x - point.x) < 0.12 && Math.abs(last.y - point.y) < 0.12 &&
       now - (this._aimAt_ || 0) < 3000) return;
    this._aim = { x: point.x, y: point.y };
    this._aimAt_ = now;
    this.refocus(point);
  };

  /* The picture is flat — out of focus, or aimed at nothing. Find where
     the print is and focus THERE, rather than assuming the centre. No
     more than once every REFOCUS_GAP so the lens is not driven back and
     forth. */
  FastDecoder.prototype._maybeRefocus = function(){
    var now = performance.now();
    if(now < (this._manualUntil || 0)) return;        // the user's tap wins
    if(now - this.startedAt < 700) return;            // let the first AF settle
    if(now - this.lastHitAt < 1200) return;           // it is working, leave it
    if(now - (this._refocusAt || 0) < REFOCUS_GAP) return;

    var spot = this._busiestSpot();
    this.refocus(spot || { x: 0.5, y: 0.5 });
    if(this.onHint){
      this.onHint(spot ? "Focusing on the barcode…" : "Refocusing…");
    }
  };

  /* ---------- accepting a result ---------- */

  function checkDigitOk(code, format){
    var f = (format || "").toUpperCase(), len = code.length;
    var applies = (f.indexOf("EAN_13") > -1 && len === 13) ||
                  (f.indexOf("EAN_8")  > -1 && len === 8)  ||
                  (f.indexOf("UPC_A")  > -1 && len === 12);
    if(!applies || !/^\d+$/.test(code)) return null;
    var body = code.slice(0, -1), sum = 0;
    for(var i = 0; i < body.length; i++){
      var d = +body.charAt(body.length - 1 - i);
      sum += (i % 2 === 0) ? d * 3 : d;
    }
    return ((10 - (sum % 10)) % 10) === +code.slice(-1);
  }

  /* How many identical reads a symbology needs before it is believed.
     EAN/UPC carry a check digit, so one verified read is proof. The
     others carry none (or a weak one) and WILL decode noise — fabric
     weave, text edges, half of a neighbouring barcode — into a
     plausible number, so they have to be seen repeatedly and
     identically before they count. ITF is the worst offender: any
     run of alternating bars can satisfy it. */
  var CONFIRMATIONS = {
    EAN_13: 1, EAN_8: 1, UPC_A: 1, UPC_E: 1,
    CODE_128: 2,        // has an internal checksum
    CODE_39: 2,
    CODABAR: 3,
    ITF: 3              // no check digit, decodes noise readily
  };
  var CONFIRM_WINDOW = 2200;   // ms: corroborating reads must be close together

  /* Shapes a real code of that symbology can actually take. */
  function plausible(text, format){
    var f = (format || "").toUpperCase();
    if(!text) return false;
    if(f.indexOf("ITF") > -1){
      // ITF encodes digit PAIRS, so an odd length is impossible, and
      // anything short is almost always noise.
      return /^\d+$/.test(text) && text.length >= 8 && text.length % 2 === 0;
    }
    if(f.indexOf("CODE_39") > -1 || f.indexOf("CODABAR") > -1) return text.length >= 4;
    if(f.indexOf("CODE_128") > -1) return text.length >= 4;
    return text.length >= 4;
  }

  /* Returns true only when the read is trustworthy. */
  FastDecoder.prototype._confirm = function(hit){
    var f = (hit.format || "").toUpperCase();
    var chk = checkDigitOk(hit.text, f);
    var now = performance.now();

    // A check digit that does NOT add up is a misread, full stop. Never
    // accept it, however many times it repeats — a systematic misread
    // repeats perfectly.
    if(chk === false){
      this.pending = null;
      this.rejected = { text: hit.text, reason: "checksum", at: now };
      return false;
    }

    // Verified check digit: proof in one read.
    if(chk === true){ this.pending = null; return true; }

    // No check digit available for this symbology.
    if(!plausible(hit.text, f)){
      this.pending = null;
      this.rejected = { text: hit.text, reason: "implausible", at: now };
      return false;
    }

    var need = CONFIRMATIONS[f] || 2;
    if(this.pending && this.pending.text === hit.text &&
       now - this.pending.at < CONFIRM_WINDOW){
      this.pending.count++;
      this.pending.at = now;
      if(this.pending.count >= need){ this.pending = null; return true; }
      return false;
    }
    this.pending = { text: hit.text, count: 1, at: now };
    return need <= 1;
  };

  /* ---------- the loop ---------- */

  FastDecoder.prototype._schedule = function(){
    var self = this, v = this.video;
    if(v.requestVideoFrameCallback){
      this._handle = v.requestVideoFrameCallback(function(){ self._tick(); });
    } else {
      this._handle = requestAnimationFrame(function(){ self._tick(); });
    }
  };

  /* Work through the plan under a time budget, resuming next frame
     where this one ran out. Over a second or so every window gets
     covered, without any single frame blowing the frame rate. */
  FastDecoder.prototype._sweep = function(t0, tried){
    var self = this;
    if(!this.running) return Promise.resolve(null);
    if(tried >= this.plan.length) return Promise.resolve(null);
    if(tried > 0 && performance.now() - t0 > FRAME_BUDGET) return Promise.resolve(null);

    var idx = this.cursor;
    this.cursor = (this.cursor + 1) % this.plan.length;
    var p = this.plan[idx];

    this._draw(p);
    if(tried === 0 && this.frames % 5 === 0){
      var q = this._measure();
      if(q){
        this._autoTorch(q);
        // a flat picture means soft focus: re-aim rather than wait
        if(q.edge < FLAT_EDGE && q.luma > DARK_LUMA) this._maybeRefocus();
        this._coach(q);
      }
    }
    return this._decode(p).then(function(hit){
      if(hit){
        self.bestPass = idx;
        if(!hit.box) hit.box = { x: p.x, y: p.y, w: p.w, h: p.h, approx: true };
        return hit;
      }
      return self._sweep(t0, tried + 1);
    });
  };

  FastDecoder.prototype._tick = function(){
    if(!this.running) return;
    var v = this.video;
    if(v.readyState < 2 || !v.videoWidth){ this._schedule(); return; }

    var self = this;
    this.frames++;
    // start each frame on the window that worked last time
    if(performance.now() - this.lastHitAt < 4000) this.cursor = this.bestPass;

    this._sweep(performance.now(), 0).then(function(hit){
      if(!self.running) return;

      if(hit && hit.text){
        self.lastHitAt = performance.now();
        self.lastHint = "";
        // Now we know exactly where the printed code is: keep focus on it
        // so the next read of the same tag is already sharp.
        if(hit.box && !hit.box.approx){
          self._lastBox = hit.box;
          self._aimAt({ x: hit.box.x + hit.box.w / 2,
                        y: hit.box.y + hit.box.h / 2 });
        }
        // the box is the spatial anchor OCR crops around
        if(self._confirm(hit) && self.onHit) self.onHit(hit.text, hit.format, hit.box);
      } else if(!self.widened && performance.now() - self.startedAt > WIDEN_MS &&
                performance.now() - self.lastHitAt > WIDEN_MS){
        self._widen().then(function(){
          if(self.onHint) self.onHint("Now trying every barcode type.");
        });
      }
      self._schedule();
    }).catch(function(){
      if(self.running) self._schedule();
    });
  };

  /* ---------- public ---------- */

  FastDecoder.prototype.start = function(stream, onHit, onHint, onTorch, onZoom){
    var self = this;
    this.onHit = onHit; this.onHint = onHint; this.onTorch = onTorch; this.onZoom = onZoom;
    this.track = stream ? stream.getVideoTracks()[0] : null;
    this.startedAt = performance.now();
    this.lastHitAt = 0; this.cursor = 0; this.bestPass = 0;
    this.frames = 0; this.torchAuto = false; this.pending = null;

    this._readZoomCaps();
    if(this.zoomCaps && this.onZoom) this.onZoom(this.zoom, this.zoomCaps);

    // Once the first frames exist, aim autofocus at wherever the print
    // actually is rather than at the middle of the picture.
    setTimeout(function(){
      if(!self.running) return;
      self._aimAt(self._busiestSpot(), true);
    }, 800);

    return this._setupNative().then(function(native){
      if(!native) self._setupZxing();
      if(!self.native && !self.zxing) throw new Error("no decoder available");
      self.running = true;
      self._schedule();
      return self.native ? "native" : "zxing";
    });
  };

  FastDecoder.prototype.stop = function(){
    this.running = false;
    try{
      if(this._handle && this.video.cancelVideoFrameCallback){
        this.video.cancelVideoFrameCallback(this._handle);
      } else if(this._handle){
        cancelAnimationFrame(this._handle);
      }
    }catch(e){}
    this._handle = null; this.track = null; this.zoomCaps = null;
  };

  /* ---------- still photos ----------
     A phone photo is ~12 megapixels. Handing that straight to ZXing
     with TRY_HARDER on eight formats locks the main thread for
     seconds, which looks exactly like a hang. Shrink first, then work
     through framings, yielding between each so the page keeps painting. */

  function stillCanvas(source, opt){
    var sw = source.naturalWidth  || source.width;
    var sh = source.naturalHeight || source.height;
    if(!sw || !sh) return null;

    var crop = opt.crop || 1;
    var cw = Math.max(16, Math.round(sw * crop));
    var ch = Math.max(16, Math.round(sh * crop));
    var sx = Math.round((sw - cw) / 2 + (opt.dx || 0) * sw);
    var sy = Math.round((sh - ch) / 2 + (opt.dy || 0) * sh);
    sx = Math.max(0, Math.min(sw - cw, sx));
    sy = Math.max(0, Math.min(sh - ch, sy));

    var cap = opt.maxEdge || 1600;
    var scale = Math.min(opt.allowUpscale ? 2.5 : 1, cap / Math.max(cw, ch));
    var dw = Math.max(32, Math.round(cw * scale));
    var dh = Math.max(32, Math.round(ch * scale));

    var c = document.createElement("canvas");
    if(opt.rotated){ c.width = dh; c.height = dw; }
    else           { c.width = dw; c.height = dh; }

    var ctx = c.getContext("2d");
    ctx.save();
    if(opt.rotated){ ctx.translate(dh, 0); ctx.rotate(Math.PI / 2); }
    ctx.drawImage(source, sx, sy, cw, ch, 0, 0, dw, dh);
    ctx.restore();
    return c;
  }

  var STILL_PASSES = [
    { maxEdge: 1600 },
    { maxEdge: 1600, rotated: true },
    { maxEdge: 1500, crop: 0.6, allowUpscale: true },
    { maxEdge: 1500, crop: 0.6, allowUpscale: true, rotated: true },
    { maxEdge: 1500, crop: 0.4, allowUpscale: true },
    { maxEdge: 1500, crop: 0.4, allowUpscale: true, rotated: true },
    { maxEdge: 1500, crop: 0.45, allowUpscale: true, dx:-0.22 },
    { maxEdge: 1500, crop: 0.45, allowUpscale: true, dx: 0.22 },
    { maxEdge: 1500, crop: 0.45, allowUpscale: true, dy:-0.22 },
    { maxEdge: 1500, crop: 0.45, allowUpscale: true, dy: 0.22 }
  ];

  function zxingStill(source, onProgress){
    if(!global.ZXing) return Promise.resolve(null);
    var Z = global.ZXing, reader, hints;
    try{
      hints = new Map();
      hints.set(Z.DecodeHintType.POSSIBLE_FORMATS,
        RETAIL.concat(EXTRA).map(function(f){ return Z.BarcodeFormat[f]; }));
      hints.set(Z.DecodeHintType.TRY_HARDER, true);   // worth it: no next frame
      reader = new Z.MultiFormatReader();
      reader.setHints(hints);
    }catch(e){ return Promise.resolve(null); }

    if(typeof Z.HTMLCanvasElementLuminanceSource !== "function"){
      return Promise.resolve(null);
    }

    function attempt(i){
      if(i >= STILL_PASSES.length) return Promise.resolve(null);
      if(onProgress) onProgress(i + 1, STILL_PASSES.length);
      return new Promise(function(resolve){
        setTimeout(function(){          // yield so the status line paints
          var hit = null;
          try{
            var c = stillCanvas(source, STILL_PASSES[i]);
            if(c){
              var src = new Z.HTMLCanvasElementLuminanceSource(c);
              var r = reader.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(src)), hints);
              if(r) hit = { text: r.getText(), format: fmtName(r) };
            }
          }catch(e){ /* NotFound — next framing */ }
          resolve(hit);
        }, 0);
      }).then(function(hit){
        return hit || attempt(i + 1);
      });
    }
    return attempt(0);
  }

  global.FastDecoder = {
    create: function(video, opts){ return new FastDecoder(video, opts); },
    decodeImage: function(source, onProgress){
      if(global.BarcodeDetector){
        return new global.BarcodeDetector().detect(source).then(function(res){
          if(res && res.length){
            return { text: res[0].rawValue, format: (res[0].format || "").toUpperCase() };
          }
          return zxingStill(source, onProgress);
        }).catch(function(){ return zxingStill(source, onProgress); });
      }
      return zxingStill(source, onProgress);
    }
  };

})(window);
