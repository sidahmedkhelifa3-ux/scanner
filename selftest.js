/* ============================================================
   selftest.js — run with:  node selftest.js
   ------------------------------------------------------------
   Loads decoder.js, store.js and scanner.js into a stubbed DOM
   and drives the paths that a browser would, so a ReferenceError
   in a callback shows up here instead of on a phone.

   `node --check` only finds syntax errors. This catches the
   "removed the variable, kept the use" class of bug — which is
   exactly what left the photo scan stuck at "Reading the photo…".
   ============================================================ */

const fs = require("fs");
const vm = require("vm");
const path = require("path");

let failures = 0;
function ok(name){ console.log("  PASS  " + name); }
function bad(name, err){
  failures++;
  console.log("  FAIL  " + name);
  console.log("        " + (err && err.stack ? err.stack.split("\n").slice(0,3).join("\n        ") : err));
}

/* ---------- minimal DOM ---------- */
function makeEl(id){
  const listeners = {};
  let _text = "", _html = "", _value = "";
  const el = {
    id, tagName: "DIV",
    hidden: false, disabled: false,
    // a real DOM stringifies these; the stub must too, or a test
    // comparing against "3" passes a number and fails confusingly
    get textContent(){ return _text; },
    set textContent(v){ _text = String(v); },
    get innerHTML(){ return _html; },
    set innerHTML(v){ _html = String(v); },
    get value(){ return _value; },
    set value(v){ _value = String(v); },
    files: [], onclick: null, style: {},
    classList: {
      _s: new Set(),
      add(c){ this._s.add(c); }, remove(c){ this._s.delete(c); },
      contains(c){ return this._s.has(c); },
      toggle(c, on){ if(on === undefined) on = !this._s.has(c);
                     if(on) this._s.add(c); else this._s.delete(c); return on; }
    },
    attrs: {},
    setAttribute(k, v){ this.attrs[k] = String(v); },
    getAttribute(k){ return k in this.attrs ? this.attrs[k] : null; },
    addEventListener(type, fn){ (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(){},
    dispatch(type, ev){ (listeners[type] || []).forEach(fn => fn(ev || { target: el })); },
    focus(){}, select(){}, scrollIntoView(){}, appendChild(){}, remove(){},
    closest(){ return null; },
    get offsetWidth(){ return 100; },
    getContext(){ return ctx2d; },
    play(){ return Promise.resolve(); }
  };
  return el;
}

const ctx2d = {
  save(){}, restore(){}, translate(){}, rotate(){}, drawImage(){},
  getImageData(x, y, w, h){ return { data: new Uint8ClampedArray(w * h * 4) }; }
};

const els = new Map();
const document = {
  getElementById(id){
    if(!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  },
  createElement(tag){ const e = makeEl("created-" + tag); e.tagName = tag.toUpperCase(); return e; },
  // document-level listeners are real behaviour (the hardware-scanner
  // wedge lives here), so they must be capturable, not swallowed
  _docListeners: {},
  addEventListener(type, fn){
    (this._docListeners[type] = this._docListeners[type] || []).push(fn);
  },
  dispatch(type, ev){ (this._docListeners[type] || []).forEach(fn => fn(ev)); },
  querySelector(){ return null; }
};

const storage = new Map();
const sandbox = {
  console,
  document,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, Map, Set, Math, JSON, Date, RegExp, Error, TypeError,
  Object, Array, String, Number, Boolean, Uint8ClampedArray, isNaN, isFinite,
  performance: { now: () => Date.now() },
  requestAnimationFrame(fn){ return setTimeout(fn, 16); },
  cancelAnimationFrame(h){ clearTimeout(h); },
  navigator: { vibrate(){}, mediaDevices: undefined, clipboard: undefined },
  localStorage: {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k)
  },
  FileReader: class {
    readAsDataURL(){ setTimeout(() => this.onload && this.onload(), 0); }
    get result(){ return "data:image/png;base64,AAAA"; }
  },
  Image: class {
    constructor(){ this.naturalWidth = 640; this.naturalHeight = 480; }
    set src(v){ this._src = v; setTimeout(() => this.onload && this.onload(), 0); }
    get src(){ return this._src; }
  },
  AudioContext: undefined,
  BarcodeDetector: undefined,   // force the ZXing path
  ZXing: undefined,             // and no ZXing either -> must fail gracefully
  addEventListener(){}, removeEventListener(){}
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* Both pages share the same fake window; only the page script differs.
   Which page is under test is chosen by PAGE below. */
const ARG = process.argv[2] || "scanner";
const PAGE = ["database", "decoder", "ocr"].includes(ARG) ? ARG : "scanner";

/* A ZXing stand-in that reports a hit on the Nth decode attempt, so the
   sweep through the scan plan can be observed. */
let zxCalls = 0, zxHitOn = 0, zxSizes = [];
function installFakeZXing(){
  function Reader(){}
  Reader.prototype.setHints = function(){};
  Reader.prototype.decodeWithState = function(){
    zxCalls++;
    const c = sandbox.__lastCanvas;
    if(c) zxSizes.push(c.width + "x" + c.height);
    // hit from this call ONWARD: the trust gate needs repeated identical
    // reads now, so a single one-off hit would never be accepted
    if(zxHitOn && zxCalls >= zxHitOn){
      const c = sandbox.__lastCanvas || { width: 760, height: 200 };
      // ZXing reports 1D result points on the barcode's centre line,
      // in canvas pixels — a quarter to three-quarters across the middle
      return {
        getText: () => "4458534760123",
        getBarcodeFormat: () => 1,
        getResultPoints: () => [
          { getX: () => c.width * 0.25, getY: () => c.height * 0.5 },
          { getX: () => c.width * 0.75, getY: () => c.height * 0.5 }
        ]
      };
    }
    throw new Error("NotFoundException");
  };
  sandbox.ZXing = {
    BarcodeFormat: { EAN_13:1, EAN_8:2, UPC_A:3, UPC_E:4,
                     CODE_128:5, CODE_39:6, ITF:7, CODABAR:8 },
    DecodeHintType: { POSSIBLE_FORMATS:1, TRY_HARDER:2 },
    HTMLCanvasElementLuminanceSource: function(c){ sandbox.__lastCanvas = c; },
    BinaryBitmap: function(){},
    HybridBinarizer: function(){},
    MultiFormatReader: Reader,
    BrowserMultiFormatReader: function(){}
  };
}

sandbox.jspdf = undefined;   // exercise the "library did not load" branch
sandbox.print = function(){ sandbox.__printed = true; };

/* The database page has no camera, so seed the store the way the
   scanner would have, before its script reads localStorage. */
if(process.argv[2] === "database" && process.argv[3] === "seeded"){
  storage.set("pyjamadz.catalog.v1", JSON.stringify({
    "4458534760123": { name: "Robe", nameAr: "روب", sku: "BASKAT Z8-1", price: 1600 }
  }));
  storage.set("pyjamadz.scanlog.v1", JSON.stringify([
    { id: "a", code: "4458534760123", at: "2026-09-25T10:02:00.000Z" },
    { id: "b", code: "4458534760123", at: "2026-09-25T10:01:00.000Z" },
    { id: "c", code: "9999999999994", at: "2026-09-25T10:00:00.000Z" }
  ]));
  sandbox.__seeded = true;
}

/* ---------- load the app ---------- */
if(PAGE === "decoder") installFakeZXing();

/* Source lives in scanner/, database/ and shared/ */
const S = f => path.join("shared", f);
const C = f => path.join("scanner", f);
const D = f => path.join("database", f);

const FILES = PAGE === "database" ? [S("common.js"), S("store.js"), D("database.js")]
            : PAGE === "decoder"  ? [C("decoder.js")]
            : PAGE === "ocr"      ? [C("ocr.js")]
            : [S("common.js"), C("decoder.js"), C("label-parser.js"), C("ocr.js"),
               S("store.js"), C("scanner.js")];

for(const f of FILES){
  try{
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
    ok("loads " + f.replace(/\\/g, "/"));
  }catch(e){
    bad("loads " + f, e);
  }
}

const status = () => document.getElementById("status").innerHTML;

/* ---------- tests ---------- */
const tests = [];

if(PAGE === "ocr"){

  const parse = (t, code) => sandbox.TagOCR.parse(t, code);

  /* Text as Tesseract would plausibly return it for the PULL tag —
     the barcode digits, the reference, the price, and the brand block
     underneath that must NOT be mistaken for the product name. */
  tests.push(function readsThePullTag(done){
    const r = parse(
      "1044797380876\n" +
      "PULL AR-195\n" +
      "1950 DA\n" +
      "PYJAMA DZ\n" +
      "FASHION\n", "1044797380876");
    if(r.price !== 1950)        return done("price -> " + r.price);
    if(r.sku !== "PULL AR-195") return done("reference -> " + r.sku);
    if(r.name !== "Pull")       return done("name -> " + r.name);
    if(r.digits !== "1044797380876") return done("digits -> " + r.digits);
    if(r.brand !== "Pyjama Dz") return done("brand -> " + r.brand);
    done(null);
  });

  
  tests.push(function readsTheBrandNameCorrectly(done){
    const r1 = parse("PYJAMA DZ\nPULL AR-195\n1950 DA\n", "1044797380876");
    if(r1.brand !== "Pyjama Dz") return done("expected Pyjama Dz, got " + r1.brand);
    const r2 = parse("MARQUE: MODA DZ\nROBE LONGUE\nREF: M-204\n3500 DA\n");
    if(r2.brand !== "Moda Dz") return done("expected Moda Dz, got " + r2.brand);
    if(r2.sku !== "M-204") return done("expected SKU M-204, got " + r2.sku);
    done(null);
  });

  tests.push(function readsTheRobeTag(done){
    const r = parse("4458534760123\nBASKAT Z8-1\n1600 DA\nMADE IN ALGERIA\n", "4458534760123");
    if(r.price !== 1600)          return done("price -> " + r.price);
    if(r.sku !== "BASKAT Z8-1")   return done("reference -> " + r.sku);
    if(r.name !== "Baskat")       return done("name -> " + r.name);
    done(null);
  });

  tests.push(function survivesSpacedAndNoisyPrices(done){
    if(parse("1 950 DA").price !== 1950)  return done("spaced price failed");
    if(parse("2.200 DA").price !== 2200)  return done("dotted price failed");
    if(parse("PRIX 1950DA").price !== 1950) return done("no-gap price failed");
    done(null);
  });

  tests.push(function takesTheLargestPriceOnTheTag(done){
    // size labels and the like can look price-ish; the real one is biggest
    const r = parse("PULL AR-195\n40 DA\n1950 DA\n");
    if(r.price !== 1950) return done("picked the wrong number -> " + r.price);
    done(null);
  });

  tests.push(function neverNamesAProductAfterTheBrand(done){
    const r = parse("PYJAMA DZ\nFASHION\nMADE IN ALGERIA\n1950 DA\n");
    if(r.sku)  return done("brand text was taken as a reference -> " + r.sku);
    if(r.name) return done("brand text was taken as a name -> " + r.name);
    if(r.price !== 1950) return done("price should still be read");
    done(null);
  });

  tests.push(function reportsAMismatchedPrintedNumber(done){
    // OCR read different digits than the scanner decoded -> caller warns
    const r = parse("1044797380999\nPULL AR-195\n1950 DA\n", "1044797380876");
    if(r.digits !== "1044797380999") return done("digits -> " + r.digits);
    if(r.digits === "1044797380876") return done("should not have matched");
    done(null);
  });

  tests.push(function handlesEmptyOcr(done){
    const r = parse("");
    if(r.price !== null || r.sku !== null || r.name !== null){
      return done("empty text should yield nothing");
    }
    if(!Array.isArray(r.lines) || r.lines.length) return done("lines should be empty");
    done(null);
  });

} else if(PAGE === "decoder"){

  // a video the decoder believes is a live 2560x1440 stream
  const video = makeEl("video");
  video.videoWidth = 2560; video.videoHeight = 1440; video.readyState = 4;

  let applied = [];
  const track = {
    getCapabilities: () => ({ zoom: { min:1, max:5, step:0.1 }, torch:true,
                              focusMode:["continuous","single-shot"] }),
    getSettings: () => ({ zoom: 1 }),
    applyConstraints(c){ applied.push(c); return Promise.resolve(); },
    stop(){}
  };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };

  let dec = null, hits = [], zooms = [];

  /* ---- engine choice ----
     Order must be: the phone's own BarcodeDetector, then zbar-wasm,
     then ZXing. Getting this backwards silently puts iPhones on the
     weakest engine, which is the whole reason zbar was added. */

  function fakeZbar(symbols){
    return {
      scanImageData: () => Promise.resolve(symbols.map(s => ({
        typeName: s.type,
        decode: () => s.text,
        points: s.points || [{ x: 100, y: 40 }, { x: 300, y: 40 }]
      })))
    };
  }

  tests.push(function prefersZbarOverZxing(done){
    sandbox.zbarWasm = fakeZbar([{ type: "ZBAR_EAN13", text: "4458534760123" }]);
    const d = sandbox.FastDecoder.create({ videoWidth: 640, videoHeight: 480, readyState: 4 });
    d.start({ getVideoTracks: () => [track] }, () => {}, () => {}, () => {}, () => {})
      .then(engine => {
        d.stop();
        sandbox.zbarWasm = undefined;
        if(engine !== "zbar") return done("picked " + engine + " when zbar-wasm was available");
        done(null);
      }).catch(e => { sandbox.zbarWasm = undefined; done("start rejected", e); });
  });

  tests.push(function fallsBackToZxingWhenZbarIsAbsent(done){
    sandbox.zbarWasm = undefined;
    const d = sandbox.FastDecoder.create({ videoWidth: 640, videoHeight: 480, readyState: 4 });
    d.start({ getVideoTracks: () => [track] }, () => {}, () => {}, () => {}, () => {})
      .then(engine => {
        d.stop();
        if(engine !== "zxing") return done("expected zxing, got " + engine);
        done(null);
      }).catch(e => done("start rejected", e));
  });

  tests.push(function zbarResultsCarryFormatAndBox(done){
    sandbox.zbarWasm = fakeZbar([{ type: "ZBAR_EAN13", text: "4458534760123" }]);
    const hits = [];
    const d = sandbox.FastDecoder.create({ videoWidth: 640, videoHeight: 480, readyState: 4 });
    d.start({ getVideoTracks: () => [track] },
            (text, fmt, box) => hits.push({ text, fmt, box }),
            () => {}, () => {}, () => {})
      .then(() => setTimeout(() => {
        d.stop();
        sandbox.zbarWasm = undefined;
        if(!hits.length) return done("a zbar read never reached the app");
        if(hits[0].text !== "4458534760123") return done("wrong text -> " + hits[0].text);
        // ZBAR_EAN13 must be translated, or the check-digit gate cannot run
        if(hits[0].fmt !== "EAN_13")
          return done("format not mapped from ZBar's name -> " + hits[0].fmt);
        if(!hits[0].box) return done("no bounding box from zbar's points");
        done(null);
      }, 300))
      .catch(e => { sandbox.zbarWasm = undefined; done("start rejected", e); });
  });

  tests.push(function zbarSymbologiesNotEnabledAreIgnored(done){
    // ITF is off by default: zbar may report it, the app must not take it
    sandbox.zbarWasm = fakeZbar([{ type: "ZBAR_I25", text: "12345678" }]);
    const hits = [];
    const d = sandbox.FastDecoder.create({ videoWidth: 640, videoHeight: 480, readyState: 4 });
    d.start({ getVideoTracks: () => [track] },
            (text) => hits.push(text), () => {}, () => {}, () => {})
      .then(() => setTimeout(() => {
        d.stop();
        sandbox.zbarWasm = undefined;
        if(hits.length) return done("accepted an ITF read that is not enabled -> " + hits[0]);
        done(null);
      }, 300))
      .catch(e => { sandbox.zbarWasm = undefined; done("start rejected", e); });
  });

  /* The user must be able to overrule the automatic choice — if the
     phone's own decoder misreads their tags, forcing zbar or demanding
     that two decoders agree is the remedy. */
  function fakeNative(text, format){
    sandbox.BarcodeDetector = function(){
      this.detect = () => Promise.resolve(text ? [{
        rawValue: text, format: (format || "ean_13"),
        boundingBox: { x: 10, y: 5, width: 120, height: 40 }
      }] : []);
    };
    sandbox.BarcodeDetector.getSupportedFormats =
      () => Promise.resolve(["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39"]);
  }

  tests.push(function engineCanBeForcedToZbar(done){
    fakeNative("4458534760123");
    sandbox.zbarWasm = fakeZbar([{ type: "ZBAR_EAN13", text: "4458534760123" }]);
    const d = sandbox.FastDecoder.create({ videoWidth: 640, videoHeight: 480, readyState: 4 },
                                         { engine: "zbar" });
    d.start({ getVideoTracks: () => [track] }, () => {}, () => {}, () => {}, () => {})
      .then(engine => {
        d.stop();
        sandbox.BarcodeDetector = undefined; sandbox.zbarWasm = undefined;
        if(engine !== "zbar")
          return done("engine:'zbar' was ignored; ran " + engine + " instead");
        done(null);
      }).catch(e => { sandbox.BarcodeDetector = undefined; sandbox.zbarWasm = undefined; done("rejected", e); });
  });

  tests.push(function crossModeAcceptsOnlyWhenBothAgree(done){
    fakeNative("4458534760123");
    // zbar reads something DIFFERENT — a disagreement must be discarded
    sandbox.zbarWasm = fakeZbar([{ type: "ZBAR_EAN13", text: "1044797380876" }]);
    const hits = [];
    const d = sandbox.FastDecoder.create({ videoWidth: 640, videoHeight: 480, readyState: 4 },
                                         { engine: "cross" });
    d.start({ getVideoTracks: () => [track] }, t => hits.push(t), () => {}, () => {}, () => {})
      .then(engine => {
        if(engine !== "cross") { d.stop(); return done("cross mode not active -> " + engine); }
        setTimeout(() => {
          d.stop();
          if(hits.length){
            sandbox.BarcodeDetector = undefined; sandbox.zbarWasm = undefined;
            return done("accepted " + hits[0] + " although the two decoders disagreed");
          }
          // now make them agree; the same code must get through
          sandbox.zbarWasm = fakeZbar([{ type: "ZBAR_EAN13", text: "4458534760123" }]);
          const d2 = sandbox.FastDecoder.create({ videoWidth: 640, videoHeight: 480, readyState: 4 },
                                                { engine: "cross" });
          const ok = [];
          d2.start({ getVideoTracks: () => [track] }, t => ok.push(t), () => {}, () => {}, () => {})
            .then(() => setTimeout(() => {
              d2.stop();
              sandbox.BarcodeDetector = undefined; sandbox.zbarWasm = undefined;
              if(!ok.length) return done("agreeing decoders still produced no read");
              if(ok[0] !== "4458534760123") return done("wrong code -> " + ok[0]);
              done(null);
            }, 400));
        }, 300);
      }).catch(e => { sandbox.BarcodeDetector = undefined; sandbox.zbarWasm = undefined; done("rejected", e); });
  });

  tests.push(function startsOnTheZxingPath(done){
    dec = sandbox.FastDecoder.create(video);
    dec.start(stream,
      (text, fmt, box) => hits.push({ text, fmt, box }),
      () => {},
      () => {},
      (z, caps) => zooms.push({ z, caps })
    ).then(engine => {
      if(engine !== "zxing") return done("expected the zxing path, got " + engine);
      done(null);
    }).catch(e => done("start rejected", e));
  });

  tests.push(function readsTheCamerasZoomRange(done){
    const caps = dec.zoomRange();
    if(!caps) return done("zoom capabilities were not read from the track");
    if(caps.max !== 5) return done("wrong zoom max -> " + JSON.stringify(caps));
    if(!zooms.length) return done("onZoom was never called at start");
    done(null);
  });

  /* The user asked for zoom to be manual only. Nothing in the engine may
     move the camera on its own, however long a scan fails. */
  tests.push(function neverZoomsWithoutTheUser(done){
    applied = [];
    setTimeout(() => {
      const zoomed = applied.filter(c =>
        c.advanced && c.advanced[0] && c.advanced[0].zoom !== undefined);
      if(zoomed.length){
        return done("the engine zoomed by itself " + zoomed.length +
                    " time(s) during a failing scan: " + JSON.stringify(zoomed));
      }
      done(null);
    }, 2600);  // past the 2.2 s at which the removed auto-zoom used to fire,
               // so this test can actually fail if it ever comes back
  });

  tests.push(function zoomIsAppliedToTheTrack(done){
    applied = [];
    dec.setZoom(3).then(okz => {
      if(!okz) return done("setZoom reported failure");
      const z = applied.find(c => c.advanced && c.advanced[0] && c.advanced[0].zoom !== undefined);
      if(!z) return done("no zoom constraint reached the track -> " + JSON.stringify(applied));
      if(z.advanced[0].zoom !== 3) return done("wrong zoom applied -> " + z.advanced[0].zoom);
      if(dec.getZoom() !== 3) return done("decoder did not record the new zoom");
      done(null);
    });
  });

  tests.push(function zoomIsClampedToWhatTheCameraHas(done){
    dec.setZoom(99).then(() => {
      if(dec.getZoom() !== 5) return done("zoom was not clamped to max -> " + dec.getZoom());
      done(null);
    });
  });

  tests.push(function sweepsSeveralWindowsPerSecond(done){
    // let the loop run; every attempt misses, so it must keep moving
    zxCalls = 0; zxSizes = [];
    setTimeout(() => {
      if(zxCalls < 8) return done("only " + zxCalls + " decode attempts in 400ms — the sweep is not advancing");
      const distinct = new Set(zxSizes);
      if(distinct.size < 4){
        return done("the sweep reused the same window: " + [...distinct].join(", "));
      }
      done(null);
    }, 400);
  });

  tests.push(function reportsAHitFromAnyWindow(done){
    hits = [];
    zxCalls = 0;
    zxHitOn = 6;               // succeed on the 6th window, not the first
    setTimeout(() => {
      zxHitOn = 0;
      if(!hits.length) return done("a hit on a later window never reached onHit");
      if(hits[0].text !== "4458534760123") return done("wrong code -> " + hits[0].text);
      if(hits[0].fmt !== "EAN_13") return done("wrong format -> " + hits[0].fmt);
      done(null);
    }, 500);
  });

  /* ---- focus ----
     A phone focuses slowly when nothing tells it where to look. The
     decoder must aim autofocus at a point, re-aim by itself when the
     picture goes flat, and NOT drive the lens back and forth. */

  /* Printed digits and bars are the highest-contrast thing on a tag, so
     focus must be aimed where the edges are — not blindly at the centre.
     The probe splits the frame into a 3x3 grid; feed it a synthetic
     frame with the "print" in one known cell and check it finds it. */
  /* A faithful model of what the probe actually receives.

     The camera frame is 1920x1080. drawImage scales it down to the probe
     canvas, which AVERAGES source pixels — and that averaging is the
     whole point: a barcode module only a few source pixels wide is
     smeared into flat grey if the probe is too small, while a bold
     printed digit (strokes ~40 source pixels) survives any downscale.

     So patterns are defined in SOURCE pixels and area-averaged into
     whatever size the probe asks for, exactly as the browser would. */
  const SRC_W = 1920, SRC_H = 1080, SUB = 8;

  function frameWith(regions, outW, outH){
    outW = outW || 480; outH = outH || 360;
    const data = new Uint8ClampedArray(outW * outH * 4);
    const stepX = SRC_W / outW;

    for(let y = 0; y < outH; y++){
      const cy = Math.floor(y * 3 / outH);
      for(let x = 0; x < outW; x++){
        const cx = Math.floor(x * 3 / outW);
        const r = regions.find(rr => rr.cx === cx && rr.cy === cy);
        const i = (y * outW + x) * 4;
        let v = 128;                                   // flat grey elsewhere

        if(r){
          // bars: one module a few source px wide. text: thick strokes.
          const mod = r.kind === "bars" ? (r.moduleSrc || 5) : 40;
          let sum = 0;
          for(let k = 0; k < SUB; k++){
            const srcX = (x + (k + 0.5) / SUB) * stepX;
            sum += (Math.floor(srcX / mod) % 2 === 0) ? 0 : 255;
          }
          v = sum / SUB;                                // the downscale average
        }
        data[i] = data[i+1] = data[i+2] = v;
        data[i+3] = 255;
      }
    }
    return { data, width: outW, height: outH };
  }

  function frameWithPrintIn(cellX, cellY){
    return (x, y, w, h) => frameWith([{ cx: cellX, cy: cellY, kind: "bars" }], w, h);
  }

  tests.push(function focusFindsThePrintedNumbers(done){
    const d = sandbox.FastDecoder.create({ videoWidth: 1920, videoHeight: 1080, readyState: 4 });
    const realGet = ctx2d.getImageData;

    // print in the bottom-right cell -> expect roughly (0.83, 0.83)
    ctx2d.getImageData = frameWithPrintIn(2, 2);
    let spot = d._busiestSpot();
    if(!spot) return done("probe returned nothing for a frame with obvious print");
    if(Math.abs(spot.x - 0.8333) > 0.02 || Math.abs(spot.y - 0.8333) > 0.02){
      ctx2d.getImageData = realGet;
      return done("aimed at " + spot.x.toFixed(2) + "," + spot.y.toFixed(2) +
                  " but the print was at 0.83,0.83");
    }

    // move the print to the top-left -> the aim must follow it
    ctx2d.getImageData = frameWithPrintIn(0, 0);
    spot = d._busiestSpot();
    ctx2d.getImageData = realGet;
    if(!spot) return done("probe returned nothing on the second frame");
    if(Math.abs(spot.x - 0.1667) > 0.02 || Math.abs(spot.y - 0.1667) > 0.02){
      return done("aim did not follow the print -> " +
                  spot.x.toFixed(2) + "," + spot.y.toFixed(2));
    }
    done(null);
  });

  /* The barcode is the thing worth focusing on. Put bars in one cell and
     a bold price in another and the bars must win — text has strong
     edges too, so raw contrast is not enough to tell them apart. */
  tests.push(function barsBeatBoldTextInTheSameFrame(done){
    const d = sandbox.FastDecoder.create({ videoWidth: 1920, videoHeight: 1080, readyState: 4 });
    const real = ctx2d.getImageData;

    ctx2d.getImageData = (x, y, w, h) => frameWith([
      { cx: 0, cy: 0, kind: "text" },     // a big bold price
      { cx: 2, cy: 2, kind: "bars" }      // the barcode
    ], w, h);
    const spot = d._busiestSpot();
    ctx2d.getImageData = real;

    if(!spot) return done("probe found nothing");
    if(Math.abs(spot.x - 0.8333) > 0.02 || Math.abs(spot.y - 0.8333) > 0.02){
      return done("aimed at " + spot.x.toFixed(2) + "," + spot.y.toFixed(2) +
                  " (the bold text) instead of the barcode at 0.83,0.83");
    }
    done(null);
  });

  /* Bars thinner than a probe pixel average into flat grey and vanish.
     At the old 240x180 this happened at any real scanning distance. */
  tests.push(function fineBarsSurviveTheProbeDownscale(done){
    const d = sandbox.FastDecoder.create({ videoWidth: 1920, videoHeight: 1080, readyState: 4 });
    const real = ctx2d.getImageData;

    // module 3 source px: an EAN-13 filling about a sixth of the frame,
    // i.e. a tag held at arm's length rather than pressed to the lens
    ctx2d.getImageData = (x, y, w, h) => frameWith([
      { cx: 0, cy: 2, kind: "bars", moduleSrc: 3 }
    ], w, h);
    const spot = d._busiestSpot();
    ctx2d.getImageData = real;

    if(!spot) return done("fine bars vanished entirely — probe resolution too low");
    if(Math.abs(spot.x - 0.1667) > 0.02 || Math.abs(spot.y - 0.8333) > 0.02){
      return done("fine bars not found; aimed at " +
                  spot.x.toFixed(2) + "," + spot.y.toFixed(2));
    }
    done(null);
  });

  tests.push(function aimDoesNotDriveTheLensConstantly(done){
    let aims = 0;
    const d = sandbox.FastDecoder.create({ videoWidth: 640, videoHeight: 480, readyState: 4 });
    d.track = {
      getCapabilities: () => ({ focusMode: ["continuous", "single-shot"], pointsOfInterest: true }),
      applyConstraints(c){
        if(c.advanced && c.advanced[0] && c.advanced[0].focusMode === "single-shot") aims++;
        return Promise.resolve();
      }
    };
    // the same spot, over and over: one drive, not twenty
    for(let i = 0; i < 20; i++) d._aimAt({ x: 0.5, y: 0.5 });
    setTimeout(() => {
      if(aims === 0) return done("never aimed at all");
      if(aims > 1) return done("drove the lens " + aims + " times for one unchanged spot");
      // a genuinely different spot SHOULD re-aim
      d._aimAt({ x: 0.16, y: 0.83 });
      setTimeout(() => {
        if(aims !== 2) return done("did not re-aim when the print moved (" + aims + " drives)");
        done(null);
      }, 30);
    }, 30);
  });

  /* A deliberate tap must own the focus: the automatic aiming may not
     drag the lens off what the user just pointed at. */
  tests.push(function aTapBeatsTheAutomaticAiming(done){
    const aims = [];
    const d = sandbox.FastDecoder.create({ videoWidth: 640, videoHeight: 480, readyState: 4 });
    d.track = {
      getCapabilities: () => ({ focusMode: ["continuous", "single-shot"], pointsOfInterest: true }),
      applyConstraints(c){
        const a = c.advanced && c.advanced[0];
        if(a && a.focusMode === "single-shot" && a.pointsOfInterest){
          aims.push(a.pointsOfInterest[0]);
        }
        return Promise.resolve();
      }
    };
    d.startedAt = sandbox.performance.now() - 5000;
    d.lastHitAt = 0;

    d.refocus({ x: 0.2, y: 0.8 }, { manual: true, hold: 2500, lock: 4000 });

    setTimeout(() => {
      const after = aims.length;
      // everything automatic should now be ignored
      d._aimAt({ x: 0.9, y: 0.1 }, true);
      d._maybeRefocus();
      setTimeout(() => {
        if(aims.length !== after)
          return done("automatic aiming overrode the tap -> " + JSON.stringify(aims));
        if(!aims.length || aims[0].x !== 0.2)
          return done("the tapped point never reached the camera -> " + JSON.stringify(aims));
        done(null);
      }, 30);
    }, 30);
  });

  tests.push(function theManualHoldExpires(done){
    const d = sandbox.FastDecoder.create({ videoWidth: 640, videoHeight: 480, readyState: 4 });
    d.track = {
      getCapabilities: () => ({ focusMode: ["continuous"], pointsOfInterest: true }),
      applyConstraints(){ return Promise.resolve(); }
    };
    d.refocus({ x: 0.2, y: 0.8 }, { manual: true, lock: 40 });
    if(!(d._manualUntil > sandbox.performance.now()))
      return done("the manual lock was never set");
    setTimeout(() => {
      if(d._manualUntil > sandbox.performance.now())
        return done("the manual lock never expires — automatic focus would stay dead");
      done(null);
    }, 80);
  });

  tests.push(function refocusAimsAtAPoint(done){
    const applied = [];
    const d = sandbox.FastDecoder.create({ videoWidth: 640, videoHeight: 480, readyState: 4 });
    d.track = {
      getCapabilities: () => ({ focusMode: ["continuous", "single-shot"], pointsOfInterest: true }),
      applyConstraints(c){ applied.push(c); return Promise.resolve(); }
    };
    d.refocus({ x: 0.25, y: 0.75 });
    setTimeout(() => {
      if(!applied.length) return done("refocus applied no constraints at all");
      const a = applied[0].advanced[0];
      if(a.focusMode !== "single-shot")
        return done("should run a single-shot cycle -> " + a.focusMode);
      if(!a.pointsOfInterest || a.pointsOfInterest[0].x !== 0.25)
        return done("the tapped point was not passed to the camera -> " + JSON.stringify(a));
      done(null);
    }, 30);
  });

  tests.push(function refocusSurvivesACameraWithNoFocusControl(done){
    const d = sandbox.FastDecoder.create({ videoWidth: 640, videoHeight: 480, readyState: 4 });
    d.track = {
      getCapabilities: () => ({}),                 // no focusMode, no POI
      applyConstraints(){ return Promise.resolve(); }
    };
    try{ d.refocus({ x: 0.5, y: 0.5 }); }
    catch(e){ return done("threw on a camera without focus control", e); }
    done(null);
  });

  tests.push(function refocusesItselfWhenTheImageIsFlat(done){
    let shots = 0;
    const d = sandbox.FastDecoder.create({ videoWidth: 640, videoHeight: 480, readyState: 4 });
    d.track = {
      getCapabilities: () => ({ focusMode: ["continuous", "single-shot"], pointsOfInterest: true }),
      applyConstraints(c){
        if(c.advanced && c.advanced[0] && c.advanced[0].focusMode === "single-shot") shots++;
        return Promise.resolve();
      }
    };
    d.startedAt = sandbox.performance.now() - 5000;   // past the settle-in window
    d.lastHitAt = 0;

    // ten flat frames in a row must not mean ten lens drives
    for(let i = 0; i < 10; i++) d._maybeRefocus();
    setTimeout(() => {
      if(shots === 0) return done("never refocused despite a flat picture");
      if(shots > 1) return done("drove the lens " + shots + " times in a burst — it will hunt");
      done(null);
    }, 40);
  });

  /* ---- trust gate ----
     A symbology with no check digit (ITF, Code 39) will decode noise
     into a plausible number. It must never reach the app on a single
     read, and a FAILING check digit must never reach it at all. These
     drive _confirm directly, since the loop is timing-dependent. */

  /* Policy: a valid check digit is necessary but NOT sufficient. Every
     format now needs CONFIRMATIONS matching reads, EAN-13 included, so a
     one-frame fluke that happens to satisfy the checksum cannot get in. */
  tests.push(function aVerifiedCheckDigitStillNeedsRepeats(done){
    const d = sandbox.FastDecoder.create({ videoWidth: 640, videoHeight: 480, readyState: 4 });
    const good = { text: "4458534760123", format: "EAN_13" };   // valid EAN-13

    let accepted = 0, reads = 0;
    while(reads < 6 && !accepted){
      reads++;
      if(d._confirm(good)) accepted = reads;
    }
    if(!accepted) return done("a valid EAN-13 was never accepted, even after 6 reads");
    if(accepted < 2) return done("accepted on the first read — the repeat gate is not applied");
    if(accepted > 3) return done("needed " + accepted + " reads; that is too slow to scan with");
    done(null);
  });

  /* Evidence from the live database: 9311460226710 came back as
     9001460226710, whose EAN-13 check digit is ALSO valid. Repetition
     cannot catch that either, because a blurred tag misreads the same
     way every frame. The corroborating reads must therefore come from
     different windows of the scan plan. */
  tests.push(function repeatsFromOneWindowAreNotEnough(done){
    const d = sandbox.FastDecoder.create({ videoWidth: 640, videoHeight: 480, readyState: 4 });
    const stuck = { text: "9001460226710", format: "EAN_13", pass: 7 };
    for(let i = 0; i < 8; i++){
      if(d._confirm(stuck))
        return done("accepted after " + (i + 1) + " reads from the SAME window — " +
                    "this is how a valid-checksum misread gets in");
    }
    done(null);
  });

  tests.push(function readsFromDifferentWindowsAreAccepted(done){
    const d = sandbox.FastDecoder.create({ videoWidth: 640, videoHeight: 480, readyState: 4 });
    const code = "9311460226710";
    let accepted = 0;
    // a real tag decodes from several different crops
    [2, 2, 5, 9].forEach((p, i) => {
      if(!accepted && d._confirm({ text: code, format: "EAN_13", pass: p })) accepted = i + 1;
    });
    if(!accepted) return done("a code seen from several windows was never accepted");
    if(accepted > 4) return done("took too many reads -> " + accepted);
    done(null);
  });

  tests.push(function neverAcceptsABadCheckDigit(done){
    const d = sandbox.FastDecoder.create({ videoWidth: 640, videoHeight: 480, readyState: 4 });
    const bad = { text: "4458534760124", format: "EAN_13" };   // last digit wrong
    for(let i = 0; i < 5; i++){
      if(d._confirm(bad))
        return done("a failing checksum was accepted after " + (i + 1) + " read(s)" +
                    " — a systematic misread repeats perfectly");
    }
    done(null);
  });

  tests.push(function itfNeedsThreeIdenticalReads(done){
    const d = sandbox.FastDecoder.create({ videoWidth: 640, videoHeight: 480, readyState: 4 });
    const noise = { text: "12345678", format: "ITF" };
    if(d._confirm(noise)) return done("ITF was accepted on the FIRST read — this is the bug");
    if(d._confirm(noise)) return done("ITF was accepted on the second read");
    if(!d._confirm(noise)) return done("ITF should be accepted on the third identical read");
    done(null);
  });

  tests.push(function differingReadsNeverAccumulate(done){
    const d = sandbox.FastDecoder.create({ videoWidth: 640, videoHeight: 480, readyState: 4 });
    // random noise gives a different number each time: never accept any of it
    for(const t of ["12345678", "87654321", "11223344", "55667788"]){
      if(d._confirm({ text: t, format: "ITF" }))
        return done("accepted " + t + " — differing reads must not corroborate");
    }
    done(null);
  });

  tests.push(function rejectsImplausibleShapes(done){
    const d = sandbox.FastDecoder.create({ videoWidth: 640, videoHeight: 480, readyState: 4 });
    // ITF encodes digit pairs: an odd length cannot exist
    for(let i = 0; i < 4; i++){
      if(d._confirm({ text: "1234567", format: "ITF" }))
        return done("accepted an odd-length ITF, which cannot be real");
    }
    // and a 2-digit "code" is noise
    for(let i = 0; i < 4; i++){
      if(d._confirm({ text: "42", format: "ITF" }))
        return done("accepted a 2-digit ITF");
    }
    done(null);
  });

  tests.push(function riskyFormatsAreOffByDefault(done){
    const d = sandbox.FastDecoder.create({ videoWidth: 640, videoHeight: 480, readyState: 4 });
    return d._widen().then(() => {
      if(d.formats.indexOf("ITF") > -1)
        return done("ITF was switched on automatically -> " + d.formats.join(","));
      if(d.formats.indexOf("CODABAR") > -1)
        return done("CODABAR was switched on automatically");
      if(d.formats.indexOf("CODE_128") === -1)
        return done("CODE_128 should still be added when widening");
      const r = sandbox.FastDecoder.create({ videoWidth: 640, videoHeight: 480, readyState: 4 },
                                           { risky: true });
      return r._widen().then(() => {
        if(r.formats.indexOf("ITF") === -1)
          return done("opting in to risky formats should add ITF");
        done(null);
      });
    }).catch(e => done("widen threw", e));
  });

  /* The barcode's box is the spatial anchor for OCR. It is produced in
     the coordinates of whichever cropped, scaled, possibly rotated
     window found the code, so it must come back as sane 0..1 frame
     coordinates — otherwise "near the barcode" is meaningless. */
  tests.push(function reportsAUsableBoundingBox(done){
    hits = [];
    zxCalls = 0;
    zxHitOn = 3;
    setTimeout(() => {
      zxHitOn = 0;
      dec.stop();
      if(!hits.length) return done("no hit to inspect");
      const b = hits[0].box;
      if(!b) return done("no bounding box was reported with the hit");
      for(const k of ["x", "y", "w", "h"]){
        if(typeof b[k] !== "number" || !isFinite(b[k]))
          return done("box." + k + " is not a finite number -> " + b[k]);
      }
      if(b.w <= 0 || b.h <= 0) return done("box has no area -> " + JSON.stringify(b));
      if(b.x < -0.01 || b.y < -0.01 || b.x + b.w > 1.01 || b.y + b.h > 1.01)
        return done("box escapes the frame -> " + JSON.stringify(b));
      if(b.approx)
        return done("fell back to the whole window instead of mapping the result points");
      // the points span half the window, so the box must be narrower than it
      if(b.w > 0.9)
        return done("box was not mapped back from canvas space -> " + JSON.stringify(b));
      done(null);
    }, 500);
  });

} else if(PAGE === "database"){

  if(!sandbox.__seeded){

    tests.push(function emptyState(done){
      setTimeout(() => {
        const list = document.getElementById("list").innerHTML;
        if(!/Nothing on the list/.test(list)) return done("database: empty state missing -> " + list);
        done(null);
      }, 80);
    });

    tests.push(function printRefusesAnEmptyList(done){
      document.getElementById("btnPrint").dispatch("click");
      setTimeout(() => {
        if(!/Nothing to print/.test(status())) return done("print: did not refuse -> " + status());
        if(sandbox.__printed) return done("print: opened the dialog for an empty list");
        done(null);
      }, 120);
    });

    tests.push(function pdfRefusesAnEmptyList(done){
      document.getElementById("btnPdf").dispatch("click");
      setTimeout(() => {
        if(!/Nothing to export/.test(status())) return done("pdf: did not refuse -> " + status());
        done(null);
      }, 60);
    });

  } else {

    tests.push(function groupsTheSeededRows(done){
      setTimeout(() => {
        const list = document.getElementById("list").innerHTML;
        // the REFERENCE headlines each row; the descriptive name supports it
        if(!/BASKAT Z8-1/.test(list))     return done("list: the reference is missing -> " + list);
        if(!/pname[^>]*>BASKAT Z8-1</.test(list))
          return done("list: the reference should be the headline, not a footnote");
        if(!/Robe/.test(list))            return done("list: the descriptive name should still show -> " + list);
        if(!/×2/.test(list))              return done("list: the two Robe scans did not group into ×2");
        if(!/No reference yet/.test(list)) return done("list: the unknown code should say it has no reference");
        if(document.getElementById("sCount").textContent !== "3")
          return done("totals: expected 3 pieces, got " + document.getElementById("sCount").textContent);
        if(document.getElementById("sItems").textContent !== "2")
          return done("totals: expected 2 products");
        // 2 x 1600 priced, third has no price -> floor marker
        if(!/^≥/.test(document.getElementById("sTotal").textContent))
          return done("totals: missing the ≥ marker for an unpriced row");
        done(null);
      }, 80);
    });

    tests.push(function printBuildsTheSheet(done){
      document.getElementById("btnPrint").dispatch("click");
      setTimeout(() => {
        const sheet = document.getElementById("sheet").innerHTML;
        if(!sheet)                          return done("print: the sheet was never built");
        if(!/<table/.test(sheet))           return done("print: no table in the sheet");
        if(!/Robe/.test(sheet))             return done("print: product name missing from the sheet");
        if(!/روب/.test(sheet))              return done("print: Arabic name missing from the sheet");
        if(!/BASKAT Z8-1/.test(sheet))      return done("print: SKU missing");
        if(!/4458534760123/.test(sheet))    return done("print: barcode missing");
        if(!/Inventaire|inventaire/.test(sheet) && !/Liste/.test(sheet))
          return done("print: no document title");
        if(!/<tfoot/.test(sheet))           return done("print: no totals row");
        if(!sandbox.__printed)              return done("print: window.print() was never called");
        done(null);
      }, 200);
    });

    tests.push(function pdfReportsAMissingLibrary(done){
      document.getElementById("btnPdf").dispatch("click");
      setTimeout(() => {
        if(!/PDF library did not load/.test(status()))
          return done("pdf: should have reported the missing library -> " + status());
        if(!/Imprimer/.test(status()))
          return done("pdf: should point the user at Imprimer as the fallback");
        done(null);
      }, 60);
    });

  }

  tests.push(function titleIsRemembered(done){
    const t = document.getElementById("docTitle");
    t.value = "Inventaire test";
    t.dispatch("input");
    if(storage.get("pyjamadz.doctitle") !== "Inventaire test"){
      return done("title: not written to storage");
    }
    done(null);
  });

} else if(PAGE === "scanner"){

tests.push(function photoPath(done){
  const input = document.getElementById("filePhoto");
  input.files = [{ name: "tag.jpg", type: "image/jpeg" }];
  try{
    input.dispatch("change");
  }catch(e){ return done("photo: change handler threw", e); }

  // FileReader -> Image -> decodeImage are each a macrotask hop
  setTimeout(() => {
    const s = status();
    if(/Reading the photo/.test(s)){
      return done("photo: still stuck on 'Reading the photo…' — the handler never completed");
    }
    // Any settled outcome is fine; what matters is that it settled and
    // did not silently record something. "not confirmed" is the newer
    // wording for a read that failed the repeated-reads gate.
    if(!/No barcode found|decoding failed|not confirmed|No item was recorded/i.test(s)){
      return done("photo: unexpected end state -> " + s);
    }
    done(null);
  }, 250);
});

tests.push(function manualEntry(done){
  document.getElementById("manualCode").value = "4458534760123";
  try{
    document.getElementById("manualGo").dispatch("click");
  }catch(e){ return done("manual: click handler threw", e); }
  setTimeout(() => {
    const s = status();
    // whatever happens to the name reading, the scan itself must be
    // confirmed and the code must reach the list
    const recent = document.getElementById("recent").innerHTML;
    if(!/4458534760123/.test(recent)) return done("manual: code did not reach the recent strip");
    if(!/on the list|added to the list/.test(s))
      return done("manual: the scan was not confirmed to the user -> " + s);
    done(null);
  }, 60);
});

tests.push(function saveProduct(done){
  document.getElementById("newName").value = "Robe";
  document.getElementById("newSku").value = "BASKAT Z8-1";
  document.getElementById("newPrice").value = "1600";
  try{
    document.getElementById("newSave").dispatch("click");
  }catch(e){ return done("save: click handler threw", e); }
  setTimeout(() => {
    const recent = document.getElementById("recent").innerHTML;
    if(!/Robe/.test(recent)) return done("save: the recent strip did not pick up the name -> " + recent);
    done(null);
  }, 60);
});

/* The camera must read the printed name by itself on a code nobody has
   named — that is the whole point of it. And exactly once per code. */
tests.push(function readsTheNameAutomatically(done){
  let reads = 0;
  // OCR now returns lines WITH geometry and the SmartLabelParser does the
  // classifying, so the stub supplies boxes rather than pre-chewed fields.
  sandbox.TagOCR.readLines = function(){
    reads++;
    return Promise.resolve({
      text: "1044797380876\nPULL AR-195\n1950 DA\nPYJAMA DZ\n",
      lines: [
        { text: "1044797380876", box: { x:0.20, y:0.30, w:0.60, h:0.05 }, conf: 90 },
        { text: "PULL AR-195",   box: { x:0.30, y:0.45, w:0.40, h:0.07 }, conf: 90 },
        { text: "1950 DA",       box: { x:0.35, y:0.62, w:0.30, h:0.09 }, conf: 90 },
        { text: "PYJAMA DZ",     box: { x:0.30, y:0.80, w:0.40, h:0.06 }, conf: 90 }
      ]
    });
  };

  document.getElementById("manualCode").value = "1044797380876";
  document.getElementById("manualGo").dispatch("click");

  setTimeout(() => {
    if(reads === 0) return done("the tag was never read automatically");
    if(reads > 1)   return done("read " + reads + " times for one code — it is looping");
    if(document.getElementById("newBrand").value !== "Pyjama Dz")
      return done("brand not filled -> " + document.getElementById("newBrand").value);
    if(document.getElementById("newName").value !== "Pull")
      return done("name not filled -> " + document.getElementById("newName").value);
    if(document.getElementById("newPrice").value !== "1950")
      return done("price not filled -> " + document.getElementById("newPrice").value);
    if(!document.getElementById("newName").classList.contains("prefilled"))
      return done("the suggested name is not marked as unconfirmed");
    // the REFERENCE is what identifies the product, so it headlines the ticket
    if(document.getElementById("tName").textContent !== "PULL AR-195")
      return done("the ticket headline should be the reference -> " +
                  document.getElementById("tName").textContent);
    if(document.getElementById("newSku").value !== "PULL AR-195")
      return done("reference not filled -> " + document.getElementById("newSku").value);
    done(null);
  }, 300);
});

tests.push(function doesNotRereadAKnownProduct(done){
  let reads = 0;
  sandbox.TagOCR.readLines = function(){ reads++; return Promise.resolve({ text: "", lines: [] }); };
  // 4458534760123 was saved to the catalog by the saveProduct test above
  document.getElementById("manualCode").value = "4458534760123";
  document.getElementById("manualGo").dispatch("click");
  setTimeout(() => {
    if(reads > 0) return done("wasted a label read on a product already in the catalog");
    done(null);
  }, 250);
});

/* The camera must open the way the phone's own camera app does: ideal
   hints only, and if the preferred request is refused, fall back rather
   than fail. A permission refusal is final and must NOT be retried. */
tests.push(function fallsBackToPlainerConstraints(done){
  const asked = [];
  sandbox.navigator.mediaDevices = {
    getUserMedia(c){
      asked.push(c);
      // refuse anything that names a resolution, like a fussy sensor would
      if(c.video && c.video.width) return Promise.reject({ name: "OverconstrainedError" });
      return Promise.resolve({
        getVideoTracks: () => [{ getCapabilities: () => ({}), getSettings: () => ({}),
                                 applyConstraints: () => Promise.resolve(), stop(){} }],
        getTracks: () => [{ stop(){} }]
      });
    }
  };
  document.getElementById("btnStart").dispatch("click");
  setTimeout(() => {
    if(asked.length < 2) return done("never fell back — only " + asked.length + " attempt(s)");
    if(asked[0].video.width === undefined) return done("the first attempt should ask for a preferred size");
    if(!asked.some(c => c.video === true || (c.video && !c.video.width)))
      return done("no plain fallback was tried -> " + JSON.stringify(asked));
    // no hard minimums anywhere: a `min` the sensor cannot meet fails outright
    for(const c of asked){
      const v = c.video;
      if(v && typeof v === "object"){
        if((v.width && v.width.min) || (v.height && v.height.min) || (v.frameRate && v.frameRate.min))
          return done("a hard `min` constraint is still being requested");
      }
    }
    done(null);
  }, 120);
});

tests.push(function doesNotRetryAPermissionRefusal(done){
  let calls = 0;
  sandbox.navigator.mediaDevices = {
    getUserMedia(){ calls++; return Promise.reject({ name: "NotAllowedError" }); }
  };
  document.getElementById("btnStart").dispatch("click");
  setTimeout(() => {
    if(calls !== 1) return done("asked " + calls + " times after a refusal — must ask once");
    if(!/permission denied/i.test(status())) return done("wrong message -> " + status());
    sandbox.navigator.mediaDevices = undefined;   // restore for later tests
    done(null);
  }, 120);
});

/* Data scanned before Supabase was configured lives in this browser
   only. Once the app is on the shared database that data is invisible,
   so it must be offered for upload — not silently abandoned. */
tests.push(function offersToRescueStrandedLocalData(done){
  // pretend the store connected to Supabase, with old data left behind
  storage.set("pyjamadz.catalog.v1", JSON.stringify({
    "1044797380876": { name: "Pull", sku: "PULL AR-195", price: 1950 }
  }));
  storage.set("pyjamadz.scanlog.v1", JSON.stringify([
    { id: "x", code: "1044797380876", at: "2026-09-25T10:00:00.000Z" },
    { id: "y", code: "1044797380876", at: "2026-09-25T10:01:00.000Z" }
  ]));

  const sent = { products: [], scans: [] };
  const fakeStore = {
    mode: "cloud", label: "supabase",
    onCatalog(){}, onScans(){},
    setProduct(code, rec){ sent.products.push(code); return Promise.resolve(); },
    addScan(rec){ sent.scans.push(rec.code); return Promise.resolve(); }
  };

  // drive the exported rescue directly against the stubbed store
  const stash = sandbox.Store.readStash();
  if(!stash || Object.keys(stash.catalog || {}).length !== 1)
    return done("readStash did not see the stranded catalog");
  if((stash.scans || []).length !== 2)
    return done("readStash did not see the stranded scans -> " + (stash.scans || []).length);

  // the banner element must exist for the scanner to be able to show it
  const bar = document.getElementById("migrate");
  const text = document.getElementById("migrateText");
  const go = document.getElementById("migrateGo");
  if(!bar || !text || !go) return done("the upload banner is missing from the page");

  // and clearStash must only wipe after a successful move
  Promise.all(Object.keys(stash.catalog).map(c => fakeStore.setProduct(c, stash.catalog[c])))
    .then(() => Promise.all(stash.scans.map(s => fakeStore.addScan(s))))
    .then(() => {
      if(sent.products.length !== 1) return done("product was not uploaded");
      if(sent.scans.length !== 2) return done("scans were not uploaded -> " + sent.scans.length);
      sandbox.Store.clearStash();
      const after = sandbox.Store.readStash();
      if(Object.keys(after.catalog || {}).length || (after.scans || []).length)
        return done("clearStash left data behind");
      done(null);
    });
});

/* A USB / Bluetooth barcode gun types the code and presses Enter. It
   must be recognised by its SPEED, never confused with a person, and
   never steal keystrokes from a field being filled in. */
tests.push(function hardwareScannerIsAccepted(done){
  const before = document.getElementById("recent").innerHTML;
  const code = "5901234123457";

  // a gun emits the whole code in a few milliseconds
  for(const ch of code) document.dispatch("keydown", { key: ch, target: document });
  document.dispatch("keydown", { key: "Enter", target: document, preventDefault(){} });

  setTimeout(() => {
    const recent = document.getElementById("recent").innerHTML;
    if(recent === before) return done("the scanner's input was ignored entirely");
    if(!recent.includes(code)) return done("code did not reach the list -> " + recent);
    done(null);
  }, 80);
});

tests.push(function humanTypingIsNotMistakenForAScanner(done){
  const typed = "9876543210982";
  let i = 0;
  // 120 ms between keys — nobody types faster than a gun, and a gun
  // never types this slowly
  (function next(){
    if(i < typed.length){
      document.dispatch("keydown", { key: typed[i++], target: document });
      return setTimeout(next, 120);
    }
    document.dispatch("keydown", { key: "Enter", target: document, preventDefault(){} });
    setTimeout(() => {
      if(document.getElementById("recent").innerHTML.includes(typed))
        return done("slow human typing was recorded as a scan");
      done(null);
    }, 60);
  })();
});

tests.push(function keystrokesInAFieldAreLeftAlone(done){
  const field = document.getElementById("manualCode");
  field.tagName = "INPUT";
  const code = "4006381333931";
  for(const ch of code) document.dispatch("keydown", { key: ch, target: field });
  document.dispatch("keydown", { key: "Enter", target: field, preventDefault(){} });
  setTimeout(() => {
    if(document.getElementById("recent").innerHTML.includes(code))
      return done("stole keystrokes from a text field the user was typing in");
    done(null);
  }, 60);
});

/* A database that predates a column must cost that ONE field, not the
   whole scan. These are the exact strings PostgREST and Postgres emit —
   the PostgREST one was captured from the live project. */
tests.push(function recognisesAMissingColumnFromRealErrors(done){
  const cases = [
    [{ code: "PGRST204",
       message: "Could not find the 'source' column of 'scans' in the schema cache" }, "source"],
    [{ code: "42703",
       message: 'column "brand" of relation "scans" does not exist' }, "brand"],
    [{ code: "42703",
       message: 'column source of relation "scans" does not exist' }, "source"],
    [{ code: "23505", message: "duplicate key value violates unique constraint" }, null],
    [null, null]
  ];
  for(const [err, want] of cases){
    const got = sandbox.Store.missingColumnName(err);
    if(got !== want){
      return done("for " + JSON.stringify(err && err.message) +
                  " got " + JSON.stringify(got) + ", want " + JSON.stringify(want));
    }
  }
  done(null);
});

tests.push(function cameraWithoutMediaDevices(done){
  try{
    document.getElementById("btnStart").dispatch("click");
  }catch(e){ return done("camera: start handler threw", e); }
  setTimeout(() => {
    if(!/No camera here/.test(status())) return done("camera: wrong message -> " + status());
    done(null);
  }, 30);
});

}

/* ---------- run ---------- */
console.log("\nDriving the " + PAGE + " page in a stubbed DOM\n");
(function next(i){
  if(i >= tests.length){
    console.log("\n" + (failures ? failures + " FAILURE(S)" : "All checks passed") + "\n");
    process.exit(failures ? 1 : 0);
  }
  const t = tests[i];
  let settled = false;
  const done = (msg, err) => {
    if(settled) return; settled = true;
    if(msg) bad(t.name, err || msg); else ok(t.name);
    next(i + 1);
  };
  try{ t(done); }catch(e){ done(t.name + " threw", e); }
  setTimeout(() => done(t.name + " timed out"), 8000);
})(0);
