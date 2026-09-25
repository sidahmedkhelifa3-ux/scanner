/* ============================================================
   Scanner page — camera, decoding, and naming a new product.
   ------------------------------------------------------------
   The list, the totals and the exports live on database.html.
   This page only reads tags and puts them in the store; it shows
   the last few scans so you can see it is working.
   ============================================================ */

(function(){
  "use strict";

  var $ = function(id){ return document.getElementById(id); };
  var esc = PDZ.esc, money = PDZ.money, clock = PDZ.clock;

  var video = $("video"), scope = $("scope"), idle = $("idle"), flash = $("flash");
  var btnStart = $("btnStart"), btnTorch = $("btnTorch"), btnManual = $("btnManual");
  var filePhoto = $("filePhoto"), statusEl = $("status"), recentEl = $("recent");

  var store = null, mode = "wait";
  var catalog = {}, scans = [], current = null;

  function say(html, isErr){
    statusEl.innerHTML = html;
    statusEl.className = isErr ? "status err" : "status";
  }
  function setSync(s, label){
    mode = s;
    $("sync").setAttribute("data-s", s);
    $("syncLabel").textContent = label;
  }
  function errText(err){
    if(!err) return "unknown error";
    return err.message || err.hint || err.code || String(err);
  }

  /* ================= ticket ================= */
  function renderTicket(code, format, sub){
    var switching = code && (!current || current.code !== code);
    if(code) current = { code: code, format: format || (current && current.code === code ? current.format : "") };
    if(!current) return;
    if(switching){
      // a different tag — drop anything suggested for the previous one
      ["newBrand","newName","newSku","newNameAr","newPrice"].forEach(function(id){
        if($(id).classList.contains("prefilled")) $(id).value = "";
      });
      clearPrefillMarks();
      $("ocrNote").textContent =
        "the barcode is only a number — the reference and price are printed beside it";
    }
    code = current.code;
    var item = catalog[code], known = !!item;

    $("tCode").textContent = code;
    PDZ.drawBars($("tBars"), code);
    $("tUnknown").hidden = known;
    $("fieldName").hidden = !known;

    var brand = (known && item.brand) ? item.brand : (current && current.brand ? current.brand : "");
    if($("tBrand")) $("tBrand").textContent = brand || "—";
    if($("tBrandField")) $("tBrandField").textContent = brand || "—";
    if($("brandRow")) $("brandRow").hidden = !brand;
    if($("fieldBrand")) $("fieldBrand").hidden = !brand;
    if($("dashBrand")) $("dashBrand").hidden = !brand;

    // The REFERENCE identifies the product on these tags, so it is the
    // headline. The descriptive name ("Robe") is secondary and optional.
    $("tName").textContent = known ? (item.sku || item.name || "Unnamed") : "Unknown item";
    $("tNameAr").textContent = known && item.nameAr ? item.nameAr : "—";
    $("tSku").textContent = known && item.name ? item.name : "";
    $("tPrice").innerHTML = (known && typeof item.price === "number")
      ? money(item.price) + '<span>DA</span>' : '—<span>DA</span>';
    if(sub !== undefined) $("tSub").textContent = sub;
    else if(known) $("tSub").textContent = item.note || "in the catalog";

    var fmt = current.format || PDZ.guessFormat(code);
    var chk = PDZ.checksumState(code, fmt);
    var meta = ['<span class="tag">' + ((fmt || "unknown format").replace(/_/g," ")) + '</span>',
                '<span class="tag">' + code.length + ' digits</span>'];
    if(chk === true) meta.push('<span class="tag ok">checksum valid</span>');
    if(chk === false) meta.push('<span class="tag bad">checksum fails</span>');
    $("tMeta").innerHTML = meta.join("");
  }

  /* ================= the short recent strip ================= */
  var freshCode = null;

  function renderRecent(){
    var s = PDZ.summarise(scans, catalog);

    if(!s.rows.length){
      recentEl.innerHTML = '<div class="empty">Nothing yet. Scan a tag and it appears here.</div>';
      return;
    }
    var html = "";
    for(var i = 0; i < Math.min(s.rows.length, 5); i++){
      var r = s.rows[i];
      // headline is the REFERENCE; the barcode, brand and descriptive
      // name are the supporting line
      var sub = [esc(r.code)];
      if(r.brand) sub.push('<strong class="bname">' + esc(r.brand) + '</strong>');
      if(r.name) sub.push(esc(r.name));
      sub.push(esc(clock(r.at)));
      html += '<div class="row' + (r.code === freshCode ? ' fresh' : '') + '">' +
        '<div class="col">' +
          '<span class="pname' + (r.title ? '' : ' none') + '">' +
            (r.title ? esc(r.title) : "No reference yet") + '</span>' +
          '<span class="name">' + sub.join(" · ") + '</span>' +
        '</div>' +
        (r.title ? "" : '<button class="namebtn" data-name="' + esc(r.code) + '">Add ref</button>') +
        '<div class="right">' +
          '<span class="qty' + (r.qty === 1 ? ' one' : '') + '">×' + r.qty + '</span>' +
          (r.line != null ? '<span class="amt">' + money(r.line) + ' DA</span>' : '') +
        '</div>' +
      '</div>';
    }
    if(s.rows.length > 5){
      html += '<div class="empty"><a href="' + esc(PDZ.appUrl("database")) + '">' +
              (s.rows.length - 5) + ' more on the list →</a></div>';
    }
    recentEl.innerHTML = html;
    freshCode = null;
  }

  recentEl.addEventListener("click", function(ev){
    if(!ev.target.closest) return;
    var namer = ev.target.closest("button[data-name]");
    if(namer) nameIt(namer.getAttribute("data-name"));
  });

  function nameIt(code){
    renderTicket(code, "", "waiting for a name");
    var box = $("tUnknown");
    if(box && !box.hidden){
      box.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(function(){ $("newName").focus(); }, 320);
    }
  }

    /* ================= smart HUD ================= */
  function updateSmartHud(code, brand, sku, price){
    var hud = $("smartHud");
    if(!hud) return;
    if($("hudValCode")) $("hudValCode").textContent = code || "—";
    if($("hudValBrand")) $("hudValBrand").textContent = brand || "—";
    if($("hudValRef")) $("hudValRef").textContent = sku || "—";
    if($("hudValPrice")) $("hudValPrice").textContent = price != null ? money(price) + " DA" : "—";
    hud.hidden = false;
  }

  /* ================= reading the printed text ================= */
  /* The barcode is only a number. The name, reference and price are
     ink beside it — so point OCR at the same picture and offer what
     it finds as a suggestion the user checks before saving. */

  var lastStill = null;      // the photo, when a photo was scanned
  var ocrDoneFor = {};       // one automatic attempt per code

  /* The frame captured at the instant the barcode was decoded. Grabbing
     it later means grabbing whatever the phone is pointed at by then. */
  var shotCode = null, shotCanvas = null, shotBox = null;

  /* The barcode's bounding box, in normalised frame coordinates, is the
     spatial anchor: capture() crops the label region around it so OCR
     sees the tag and not the whole room. */
  function grabShot(code, box){
    if(!(decoder && running)) return;
    var c = decoder.capture(1400, box || null);
    if(c){ shotCode = code; shotCanvas = c; shotBox = box || null; }
  }

  function ocrSource(){
    if(current && shotCode === current.code && shotCanvas) return shotCanvas;
    if(decoder && running){
      var c = decoder.capture(1400, (current && current.box) || null);
      if(c) return c;
    }
    return lastStill;
  }

  /* The barcode box expressed in the CROP's coordinate space, so the
     parser can measure "how far is this line from the bars". */
  function boxInCrop(src){
    var box = (current && current.box) || shotBox;
    if(!box) return null;
    var r = src && src.__region;
    if(!r || !r.w || !r.h) return box;
    return {
      x: (box.x - r.x) / r.w,
      y: (box.y - r.y) / r.h,
      w: box.w / r.w,
      h: box.h / r.h
    };
  }

  function markPrefilled(id, value){
    var el = $(id);
    if(value === null || value === undefined || value === "") return false;
    if(el.value.trim()) return false;          // never overwrite typing
    el.value = String(value);
    el.classList.add("prefilled");
    return true;
  }

  function clearPrefillMarks(){
    ["newBrand","newName","newSku","newNameAr","newPrice"].forEach(function(id){
      $(id).classList.remove("prefilled");
    });
  }

  function readTag(auto){
    if(!current) return;
    if(!global_TagOCR()){
      $("ocrNote").textContent = "the text reader is not available here — type the details in";
      return;
    }
    var src = ocrSource();
    if(!src){
      $("ocrNote").textContent = auto ? "" : "start the camera or scan a photo first, then read the tag";
      return;
    }

    var code = current.code;
    $("btnOcr").disabled = true;
    $("ocrNote").textContent = "loading the text reader…";

    var onStage = function(stage, p){
      var pct = p ? " " + Math.round(p * 100) + "%" : "";
      $("ocrNote").textContent = String(stage).replace(/_/g, " ") + pct;
    };

    /* One OCR pass over the cropped label, then the deterministic
       SmartLabelParser. No model, no network — regex, keywords and the
       geometry of each line relative to the barcode. */
    TagOCR.readLines(src, onStage).then(function(ocr){
      var structured = LabelParser.parse({
        barcode: code,
        barcodeBox: boxInCrop(src),
        lines: ocr.lines
      });
      // keep the legacy brand/Arabic reading, which the parser does not do
      var legacy = TagOCR.parse(ocr.text, code);

      return {
        brand:  legacy.brand,
        name:   structured.productName || legacy.name,
        sku:    structured.productCode || legacy.sku,
        price:  structured.price != null ? structured.price : legacy.price,
        digits: legacy.digits,
        lines:  ocr.lines,
        confidence: structured.confidence,
        structured: structured
      };
    }).then(function(found){
      $("btnOcr").disabled = false;
      if(!current || current.code !== code) return;   // they moved on

      lastResult = {
        barcode: code,
        productCode: found.sku || null,
        productName: found.name || null,
        price: found.price != null ? found.price : null,
        brand: found.brand || null,
        confidence: found.confidence
      };

      var filled = [];
      if(markPrefilled("newBrand", found.brand)) filled.push("brand");
      if(markPrefilled("newName",  found.name))  filled.push("name");
      if(markPrefilled("newSku",   found.sku))   filled.push("reference");
      if(markPrefilled("newPrice", found.price)) filled.push("price");

      if(found.brand && current) current.brand = found.brand;
      if(found.sku && current) current.sku = found.sku;
      updateSmartHud(code, found.brand, found.sku, found.price);
      showConfidence(found.confidence);

      if(filled.length){
        // Put it on the ticket too, so the camera visibly read the name & brand
        if(found.brand){
          if($("tBrand")) $("tBrand").textContent = found.brand;
          if($("tBrandField")) $("tBrandField").textContent = found.brand;
          if($("brandRow")) $("brandRow").hidden = false;
          if($("fieldBrand")) $("fieldBrand").hidden = false;
          if($("dashBrand")) $("dashBrand").hidden = false;
        }
        if(found.sku || found.name){
          $("tName").textContent = found.sku || found.name || "Read from the tag";
          $("fieldName").hidden = false;
          $("tSku").textContent = found.sku ? (found.name || "") : "";
        }
        if(found.price != null) $("tPrice").innerHTML = money(found.price) + '<span>DA</span>';
        $("tSub").textContent = "read from the tag — tap Save to keep it";

        var mismatch = found.digits && found.digits !== code;
        $("ocrNote").innerHTML = "Read from the tag: " + filled.join(", ") +
          ". <b>Check it, then save.</b>" +
          (mismatch ? " The digits it read under the bars (" + esc(found.digits) +
                      ") do not match the scanned code — check carefully." : "");
        say("<b>" + esc(found.sku || found.name || code) + "</b>" +
            (found.price != null ? " · " + money(found.price) + " DA" : "") +
            " read from the tag. <em>Tap Save to keep it.</em>");
      } else {
        $("ocrNote").textContent = found.lines.length
          ? "Could not pick out a name or price. Type them in."
          : "No text found — hold the label steadier and try again.";
        if(auto) say("<b>" + esc(code) + "</b> is on the list, but the printed name was not legible. Type it in below.", true);
      }
    }).catch(function(err){
      $("btnOcr").disabled = false;
      $("ocrNote").textContent = "Text reading failed — " + errText(err) + ". Type the details in.";
      if(auto){
        ocrDoneFor[code] = false;               // let a retry happen
        // still confirm the scan itself — only the name reading failed
        say("<b>" + esc(code) + "</b> is on the list, but the name could not be read. " +
            "Tap <em>Read the tag</em> to retry, or type it in.", true);
      }
    });
  }

  function global_TagOCR(){ return typeof TagOCR !== "undefined" && TagOCR && TagOCR.available; }

  /* The last structured result, in the shape the spec asks for:
     { barcode, productCode, productName, price, confidence } */
  var lastResult = null;
  function scanResult(){ return lastResult; }

  /* Never silently guess. Below 0.7 the fields are shown as a proposal
     that has to be looked at; above it, they read as confirmed. */
  var CONF_FLOOR = 0.7;
  function showConfidence(c){
    var el = $("ocrNote");
    if(typeof c !== "number") return;
    var low = c < CONF_FLOOR;
    if($("tSub")) $("tSub").textContent = low
      ? "read from the tag — low confidence, check before saving"
      : "read from the tag — tap Save to keep it";
    if(el) el.setAttribute("data-conf", low ? "low" : "ok");
    ["newBrand","newName","newSku","newPrice"].forEach(function(id){
      var f = $(id);
      if(f && f.classList.contains("prefilled")) f.classList.toggle("lowconf", low);
    });
  }

  $("btnOcr").addEventListener("click", function(){ readTag(false); });

  /* ================= writes ================= */
  function saveScan(code, format, brand){
    var item = catalog[code];
    return store.addScan({
      code: code,
      brand: item ? (item.brand || null) : (brand || null),
      name: item ? (item.name || null) : null,
      sku: item ? (item.sku || null) : null,
      price: item && typeof item.price === "number" ? item.price : null,
      at: new Date().toISOString(),
      format: format || ""
    }).catch(function(err){
      say("<b>Scan not saved</b> — " + esc(errText(err)), true);
    });
  }

  $("newSave").addEventListener("click", function(){
    if(!current || !store) return;
    var code = current.code;
    // The reference identifies the product; the descriptive name is
    // optional, so a tag with only a reference saves perfectly well.
    var ref  = $("newSku").value.trim();
    var desc = $("newName").value.trim();
    if(!ref && !desc){
      say("<b>Enter the reference</b> printed on the tag before saving.", true);
      return;
    }
    var rec = {
      brand: $("newBrand") ? $("newBrand").value.trim() : "",
      name: desc || ref,
      nameAr: $("newNameAr").value.trim(),
      sku: ref || desc,
      price: $("newPrice").value === "" ? null : Number($("newPrice").value)
    };
    $("newSave").disabled = true;
    store.setProduct(code, rec).then(function(){
      $("newSave").disabled = false;
      ["newBrand","newName","newSku","newNameAr","newPrice"].forEach(function(id){ $(id).value = ""; });
      renderTicket(code, "", "saved");
      say("<b>Saved.</b> " + esc(rec.sku) + " is priced from now on" +
          (mode === "cloud" ? " — on every phone." : "."));
    }).catch(function(err){
      $("newSave").disabled = false;
      say("<b>Could not save</b> — " + esc(errText(err)), true);
    });
  });

  /* ================= feedback ================= */
  var audioCtx = null;
  function beep(ok){
    try{
      var AC = window.AudioContext || window.webkitAudioContext;
      if(!AC) return;
      if(!audioCtx) audioCtx = new AC();
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "square";
      o.frequency.value = ok ? 1180 : 320;
      g.gain.setValueAtTime(0.06, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.13);
    }catch(e){}
  }
  function hit(){
    flash.classList.remove("hit"); void flash.offsetWidth; flash.classList.add("hit");
    if(navigator.vibrate){ try{ navigator.vibrate(40); }catch(e){} }
  }

  /* ================= accept a code ================= */
  var lastCode = "", lastAt = 0, pendingBox = null;
  function accept(code, format, box, quiet, ocrPreload){
    code = String(code).trim();
    if(!code || !store) return;
    var now = Date.now();
    var repeated = code === lastCode && now - lastAt < 2500;
    if(repeated && !ocrPreload) return;   // one tag, one count; still accept its OCR details
    if(!repeated){ lastCode = code; saveScan(code, format, ocrPreload ? ocrPreload.brand : null); }
    lastAt = now;
    // keep the barcode's box: it anchors the OCR crop and the parser
    if(box && current && current.code === code) current.box = box;
    pendingBox = box || null;

    var item = catalog[code];
    if(!quiet){ hit(); beep(!!item); }

    freshCode = code;
    if(ocrPreload && ocrPreload.brand && !current) current = { code: code, brand: ocrPreload.brand };
    else if(ocrPreload && ocrPreload.brand && current) current.brand = ocrPreload.brand;

    renderTicket(code, format, item ? "just scanned" : "just scanned — not in the catalog");

    if(ocrPreload){
      lastResult = {
        barcode: code,
        productCode: ocrPreload.sku || null,
        productName: ocrPreload.name || null,
        price: ocrPreload.price != null ? ocrPreload.price : null,
        brand: ocrPreload.brand || null,
        confidence: ocrPreload.confidence
      };
      showConfidence(ocrPreload.confidence);
      markPrefilled("newBrand", ocrPreload.brand);
      markPrefilled("newName",  ocrPreload.name);
      markPrefilled("newSku",   ocrPreload.sku);
      markPrefilled("newPrice", ocrPreload.price);
      if(ocrPreload.brand){
        if($("tBrand")) $("tBrand").textContent = ocrPreload.brand;
        if($("tBrandField")) $("tBrandField").textContent = ocrPreload.brand;
        if($("brandRow")) $("brandRow").hidden = false;
        if($("fieldBrand")) $("fieldBrand").hidden = false;
        if($("dashBrand")) $("dashBrand").hidden = false;
      }
      if(ocrPreload.sku || ocrPreload.name){
        $("tName").textContent = ocrPreload.sku || ocrPreload.name || "Read from the tag";
        $("fieldName").hidden = false;
        $("tSku").textContent = ocrPreload.sku ? (ocrPreload.name || "") : "";
      }
      if(ocrPreload.price != null) $("tPrice").innerHTML = money(ocrPreload.price) + '<span>DA</span>';
      updateSmartHud(code, ocrPreload.brand, ocrPreload.sku, ocrPreload.price);
    }

    var seen = 0;
    for(var i=0;i<scans.length;i++){ if(scans[i].code === code) seen++; }
    var qty = seen + (mode === "local" ? 0 : 1);
    var brandPrefix = (item && item.brand) ? item.brand + " · " : (ocrPreload && ocrPreload.brand ? ocrPreload.brand + " · " : "");

    if(item){
      say("<b>" + esc(brandPrefix + (item.sku || item.name || code)) + "</b> added to the list" + (qty > 1 ? " — now ×" + qty + "." : "."));
    } else if(ocrPreload && (ocrPreload.name || ocrPreload.sku || ocrPreload.brand)){
      say("✨ <b>" + esc(brandPrefix + (ocrPreload.sku || ocrPreload.name || code)) + "</b>" +
          (ocrPreload.price != null ? " · " + money(ocrPreload.price) + " DA" : "") +
          " read from the tag. <em>Tap Save to keep it.</em>");
    } else if(!ocrDoneFor[code]){
      ocrDoneFor[code] = true;
      grabShot(code, pendingBox);          // crop the label around the bars
      say("<b>" + esc(code) + "</b> — reading the name on the tag…");
      setTimeout(function(){ readTag(true); }, 60);
    } else {
      say("<b>" + esc(code) + "</b> is on the list. Give it a name so it reads properly.");
    }
  }

  /* ================= camera ================= */
  var stream = null, decoder = null, running = false, torchOn = false;

  function stopCamera(){
    running = false;
    if(decoder){ decoder.stop(); decoder = null; }
    if(stream){ stream.getTracks().forEach(function(t){ try{ t.stop(); }catch(e){} }); stream = null; }
    video.hidden = true; idle.hidden = false;
    scope.setAttribute("data-state","idle");
    btnStart.textContent = "Start camera";
    btnStart.classList.add("primary");
    $("camBar").hidden = true;
    $("zoomBar").hidden = true;
    torchOn = false;
    scope.style.aspectRatio = "";     // back to the idle placeholder shape
  }

  /* Open the back camera the way the phone's own camera app would.
     Only IDEAL hints — no hard minimums — because a `min` the sensor
     cannot meet makes getUserMedia fail outright or drop into an odd
     mode. If the preferred request is refused, fall back to plainer
     ones rather than giving up. */
  function openCamera(){
    var attempts = [
      { video: { facingMode: { ideal: "environment" },
                 width:  { ideal: 1920 },
                 height: { ideal: 1080 } }, audio: false },
      { video: { facingMode: { ideal: "environment" } }, audio: false },
      { video: true, audio: false }
    ];
    var i = 0;
    function attempt(lastErr){
      if(i >= attempts.length) return Promise.reject(lastErr || new Error("no camera"));
      var want = attempts[i++];
      return navigator.mediaDevices.getUserMedia(want).catch(function(err){
        var n = err && err.name;
        // a refusal is final — retrying would just nag the user
        if(n === "NotAllowedError" || n === "SecurityError") throw err;
        return attempt(err);
      });
    }
    return attempt(null);
  }

  /* Show the whole picture the camera gives, at its own shape. The box
     used to be locked to 4:3 with object-fit:cover, which cropped a
     16:9 stream by about a quarter — it looked zoomed in, and the
     aiming brackets no longer matched the area the decoder scans. */
  function fitPreview(){
    var vw = video.videoWidth, vh = video.videoHeight;
    if(vw && vh) scope.style.aspectRatio = vw + " / " + vh;
  }
  video.addEventListener("loadedmetadata", fitPreview);
  video.addEventListener("resize", fitPreview);

  function startCamera(){
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      say("<b>No camera here.</b> The page must be served over HTTPS (or localhost) for the camera to work. Use <em>Scan a photo</em> meanwhile.", true);
      return;
    }
    say("<b>Opening the camera…</b> allow access when your browser asks.");

    openCamera().then(function(s){
      stream = s; video.srcObject = s;
      video.hidden = false; idle.hidden = true;
      scope.setAttribute("data-state","live");
      btnStart.textContent = "Stop camera";
      btnStart.classList.remove("primary");
      running = true;
      return video.play().catch(function(){});
    }).then(function(){
      fitPreview();
      tuneCamera();
      setupTorch();
      decoder = FastDecoder.create(video);
      return decoder.start(stream, accept, onCoach, onAutoTorch, onZoom);
    }).then(function(){
      say(decoder.zoomRange()
        ? "<b>Scanning.</b> Sweeping the whole picture — tap a zoom if the tag is far."
        : "<b>Scanning.</b> Sweeping the whole picture at several scales.");
    }).catch(function(err){
      var n = (err && err.name) || "";
      if(n === "NotAllowedError") say("<b>Camera permission denied.</b> Allow it, or use <em>Scan a photo</em>.", true);
      else if(n === "NotFoundError" || n === "OverconstrainedError") say("<b>No usable camera found.</b> Try <em>Scan a photo</em>.", true);
      else if(String(err && err.message).indexOf("no decoder") > -1)
        say("<b>Decoder did not load.</b> Check your connection, or use <em>Type code</em>.", true);
      else say("<b>Camera did not open</b> (" + esc(n || errText(err)) + "). Use <em>Scan a photo</em>.", true);
      stopCamera();
    });
  }

  /* The decoder only speaks up once scanning has clearly stalled. */
  function onCoach(msg){ say("<b>" + esc(msg) + "</b>"); }

  function onAutoTorch(on){
    $("camBar").hidden = false;
    paintTorch(on);
  }

  /* ---- zoom: the one control that really extends reading distance ---- */
  var zoomBar = $("zoomBar");

  function onZoom(z, caps){
    if(!caps){ zoomBar.hidden = true; return; }
    zoomBar.hidden = false;
    var btns = zoomBar.querySelectorAll("button");
    for(var i = 0; i < btns.length; i++){
      var want = zoomFor(btns[i].getAttribute("data-zoom"), caps);
      btns[i].setAttribute("aria-pressed", Math.abs(want - z) < 0.15 ? "true" : "false");
      // hide a step the camera cannot actually reach
      btns[i].hidden = want > caps.max + 0.01;
    }
  }

  function zoomFor(key, caps){
    if(key === "max") return caps.max;
    return Math.min(caps.max, caps.min * Number(key));
  }

  zoomBar.addEventListener("click", function(ev){
    var b = ev.target.closest ? ev.target.closest("button[data-zoom]") : null;
    if(!b || !decoder) return;
    var caps = decoder.zoomRange();
    if(!caps) return;
    decoder.setZoom(zoomFor(b.getAttribute("data-zoom"), caps));
  });

  /* Where in the PICTURE did they tap? The video is object-fit:contain
     inside its box, so the image may be letterboxed — mapping from the
     container rect would aim the camera at the wrong place. Map through
     the drawn image instead. */
  function pointInVideo(ev){
    try{
      if(typeof ev.clientX !== "number" || !video.getBoundingClientRect) return null;
      return PDZ.pointInImage(video.getBoundingClientRect(),
                              video.videoWidth, video.videoHeight,
                              ev.clientX, ev.clientY);
    }catch(e){ return null; }
  }

  /* Tap on the barcode and the camera focuses there straight away. If the
     tap lands on or near where the bars were last seen, snap to the exact
     centre of them — that is what "click on the code bar" should mean. */
  scope.addEventListener("click", function(ev){
    if(!decoder || !running) return;
    if(ev.target.closest && ev.target.closest(".zoomBar")) return;

    var point = pointInVideo(ev);
    if(!point) return;

    var box = decoder.lastBox && decoder.lastBox();
    point = PDZ.snapToBox(point, box);
    var onBars = !!point.snapped;

    // manual: hold focus there and keep the automatic aiming off it
    decoder.refocus(point, { manual: true, hold: 2500, lock: 4000 });
    showFocusRing(point, onBars);
    say(onBars ? "<b>Focusing on the barcode…</b>" : "<b>Focusing there…</b>");
  });

  /* A brief ring where you tapped, so the tap visibly did something. */
  function showFocusRing(point, onBars){
    if(!point) return;
    var ring = document.createElement("div");
    ring.className = onBars ? "focusRing onBars" : "focusRing";
    ring.style.left = (point.x * 100) + "%";
    ring.style.top  = (point.y * 100) + "%";
    scope.appendChild(ring);
    setTimeout(function(){
      if(ring.parentNode) ring.parentNode.removeChild(ring);
    }, 700);
  }

  /* Continuous autofocus is the biggest camera-side win: a tag held
     close goes soft on most phones without it. Best effort only. */
  function tuneCamera(){
    try{
      var track = stream.getVideoTracks()[0];
      if(!track || !track.applyConstraints) return;
      var caps = track.getCapabilities ? track.getCapabilities() : {};
      var adv = {};
      if(caps.focusMode && caps.focusMode.indexOf("continuous") > -1){
        adv.focusMode = "continuous";
      }
      // Tell the camera WHERE to focus. Without this it hunts across the
      // whole scene and often settles on the background instead of the
      // tag, which is what made focusing feel slow.
      if(caps.pointsOfInterest) adv.pointsOfInterest = [{ x: 0.5, y: 0.5 }];
      // Let exposure track the tag too, so a bright label is not blown out.
      if(caps.exposureMode && caps.exposureMode.indexOf("continuous") > -1){
        adv.exposureMode = "continuous";
      }
      if(Object.keys(adv).length){
        track.applyConstraints({ advanced: [adv] }).catch(function(){});
      }
    }catch(e){}
  }

  /* Flash / torch. Shown only when the camera actually reports one —
     iOS Safari exposes no torch control to web pages at all, so there
     the button stays hidden rather than pretending. */
  function paintTorch(on){
    torchOn = !!on;
    btnTorch.setAttribute("aria-pressed", torchOn ? "true" : "false");
    var label = $("torchLabel");
    if(label) label.textContent = torchOn ? "Allumée" : "Lampe";
  }

  function setTorch(on){
    if(!stream) return Promise.resolve(false);
    var track = stream.getVideoTracks()[0];
    if(!track || !track.applyConstraints) return Promise.resolve(false);
    return track.applyConstraints({ advanced: [{ torch: !!on }] })
      .then(function(){ paintTorch(on); return true; })
      .catch(function(){
        $("camBar").hidden = true;          // the camera lied about torch
        return false;
      });
  }

  function setupTorch(){
    try{
      var track = stream.getVideoTracks()[0];
      var caps = track && track.getCapabilities ? track.getCapabilities() : {};
      if(!caps || !caps.torch){ $("camBar").hidden = true; return; }

      $("camBar").hidden = false;
      paintTorch(false);

      btnTorch.onclick = function(){
        // Once you choose, the automatic dark-detection stops second-
        // guessing you — same rule as zoom and focus.
        if(decoder && decoder.holdTorch) decoder.holdTorch();
        setTorch(!torchOn);
      };
    }catch(e){}
  }

  btnStart.addEventListener("click", function(){ running ? stopCamera() : startCamera(); });
  /* ================= smart camera scan ================= */
  function doSmartScan(){
    if(!running){
      startCamera();
      say("<b>Camera started.</b> Point it at the tag and tap <em>⚡ Scan intelligent</em>.");
      return;
    }
    say("<b>⚡ Scanning tag…</b> reading barcode, reference, and brand.");
    hit();
    var c = decoder ? decoder.capture(1800) : null;
    if(!c){
      say("<b>Frame not ready.</b> Hold the phone steady and retry.", true);
      return;
    }
    var smartBtn = $("btnSmartScan");
    if(smartBtn) smartBtn.disabled = true;

    FastDecoder.decodeImage(c, null).then(function(barHit){
      var barCode = barHit ? barHit.text : null;
      // Focus OCR on the detected tag instead of the full camera view.
      var label = barHit && decoder ? decoder.capture(1800, barHit.box) : c;
      if(!label) label = c;
      return TagOCR.readLines(label, function(stage, pct){
        var p = pct ? " " + Math.round(pct * 100) + "%" : "";
        say("<b>⚡ Smart reading:</b> " + String(stage).replace(/_/g, " ") + p);
      }).then(function(ocr){
        var barcodeBox = null;
        if(barHit && barHit.box && label.__region){
          var region = label.__region, b = barHit.box;
          barcodeBox = { x:(b.x-region.x)/region.w, y:(b.y-region.y)/region.h,
            w:b.w/region.w, h:b.h/region.h };
        } else if(barHit) barcodeBox = barHit.box;
        var structured = LabelParser.parse({ barcode:barCode, barcodeBox:barcodeBox, lines:ocr.lines });
        var legacy = TagOCR.parse(ocr.text, barCode);
        var ocrRes = {
          brand:structured.brand || legacy.brand,
          sku:structured.productCode || legacy.sku,
          name:structured.productName || legacy.name,
          price:structured.price != null ? structured.price : legacy.price,
          digits:legacy.digits,
          confidence:structured.confidence
        };
        if(smartBtn) smartBtn.disabled = false;
        var ocrCode = ocrRes && ocrRes.digits;
        var ocrFormat = ocrCode ? PDZ.guessFormat(ocrCode) : "";
        var code = barCode || (ocrCode && PDZ.checksumState(ocrCode, ocrFormat) === true ? ocrCode : null);
        var fmt = (barHit && barHit.format) || (code ? PDZ.guessFormat(code) : "");
        if(code){
          accept(code, fmt, (barHit && barHit.box) || null, false, ocrRes);
        } else {
          say("<b>No tag recognized.</b> Move camera closer to the barcode & label.", true);
        }
      });
    }).catch(function(err){
      if(smartBtn) smartBtn.disabled = false;
      say("<b>Smart scan failed:</b> " + esc(errText(err)), true);
    });
  }

  var btnSmartScan = $("btnSmartScan");
  if(btnSmartScan) btnSmartScan.addEventListener("click", doSmartScan);


  /* ================= photo ================= */
  filePhoto.addEventListener("change", function(){
    var f = filePhoto.files && filePhoto.files[0];
    if(!f) return;
    say("<b>Reading the photo…</b>");
    var fr = new FileReader();
    fr.onload = function(){
      var img = new Image();
      img.onload = function(){ lastStill = img; decodeImage(img); };
      img.onerror = function(){ say("<b>That file could not be opened</b> as an image.", true); };
      img.src = fr.result;
    };
    fr.onerror = function(){ say("<b>Could not read the file.</b>", true); };
    fr.readAsDataURL(f);
    filePhoto.value = "";
  });

  function decodeImage(img){
    FastDecoder.decodeImage(img, function(pass, total){
      if(pass > 1) say("<b>Still looking…</b> trying a different framing (" + pass + " of " + total + ")");
    }).then(function(hit){
      if(hit && hit.text){
        if(global_TagOCR()){
          TagOCR.read(img, hit.text).then(function(ocrRes){
            accept(hit.text, hit.format, hit.box || null, false, ocrRes);
          }).catch(function(){
            accept(hit.text, hit.format, hit.box || null);
          });
        } else {
          accept(hit.text, hit.format, hit.box || null);
        }
      } else if(global_TagOCR()){
        TagOCR.read(img, null).then(function(ocrRes){
          if(ocrRes && ocrRes.digits && PDZ.checksumState(ocrRes.digits, PDZ.guessFormat(ocrRes.digits)) === true){
            accept(ocrRes.digits, PDZ.guessFormat(ocrRes.digits), null, false, ocrRes);
          } else {
            say("<b>No barcode found in that photo.</b> Fill more of the frame with the tag, keep the bars straight, and avoid glare.", true);
          }
        }).catch(function(){
          say("<b>No barcode found in that photo.</b> Fill more of the frame with the tag, keep the bars straight, and avoid glare.", true);
        });
      } else {
        say("<b>No barcode found in that photo.</b> Fill more of the frame with the tag, keep the bars straight, and avoid glare.", true);
      }
    }).catch(function(err){
      say("<b>Photo decoding failed</b> — " + esc(errText(err)) + ". Use <em>Type code</em>.", true);
    });
  }

  /* ================= manual ================= */
  btnManual.addEventListener("click", function(){
    var p = $("manualPanel");
    p.hidden = !p.hidden;
    if(!p.hidden) $("manualCode").focus();
  });
  function manualGo(){
    var v = $("manualCode").value.replace(/\D/g,"");
    if(v.length < 6){ say("<b>Too short.</b> Type every digit printed under the bars.", true); return; }
    lastCode = "";
    accept(v, PDZ.guessFormat(v), null, true);
    $("manualCode").value = "";
  }
  $("manualGo").addEventListener("click", manualGo);
  $("manualCode").addEventListener("keydown", function(e){ if(e.key === "Enter") manualGo(); });

  /* ================= start ================= */
  renderRecent();
  window.addEventListener("pagehide", stopCamera);

  Store.open().then(function(res){
    store = res.store;
    setSync(store.mode, store.label);

    store.onCatalog(function(c){ catalog = c; renderRecent(); renderTicket(null); });
    store.onScans(function(s){ scans = s; renderRecent(); });

    $("footNote").textContent = (store.mode === "cloud")
      ? "Shared database — every phone sees the same list."
      : "Saved in this browser only. Add Supabase keys in config.js to share across phones.";

    // Split deployments meet ONLY in Supabase. Without it each app keeps
    // its own private storage and neither sees the other's scans — a
    // silent failure, so it is said out loud.
    if(PDZ.isSplit() && store.mode !== "cloud"){
      say("<b>The database app cannot see these scans.</b> The two apps are " +
          "deployed separately, so they share data only through Supabase — " +
          "fill in supabaseUrl and supabaseAnonKey in config.js.", true);
    }

    if(res.fellBack){
      say("<b>Supabase unreachable</b> — " + esc(res.reason) + " Working on this device instead.", true);
    }
  }).catch(function(err){
    say("<b>Storage failed to start</b> — " + esc(errText(err)), true);
  });

})();
