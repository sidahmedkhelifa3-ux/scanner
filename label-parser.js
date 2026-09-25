/* ============================================================
   SmartLabelParser — deterministic, no model, no network
   ------------------------------------------------------------
   Turns OCR output into a structured result:

     { barcode, productCode, productName, price, brand, confidence }

   NOTHING here guesses with a language model. It is regex,
   keyword matching, geometry and a scoring table, so it runs in
   under a millisecond and behaves identically every time.

   The barcode is the ANCHOR. Its bounding box is passed in, and
   every OCR line is scored partly on where it sits relative to
   that box. Position is deliberately NOT hardcoded as "above" or
   "below" — labels differ, so distance and reading order are
   used, never a fixed side.

   Pure function, no DOM, no globals touched: testable on its own
   with `node selftest.js parser`.
   ============================================================ */

(function(global){
  "use strict";

  /* ---------- patterns ---------- */

  // "1600 DA", "1 800 DA", "2300DA", "1600 DZD", "1950 دج"
  var PRICE_RE = /(\d[\d\s.,]{0,9})\s*(?:DA|DZD|DZ|د\.?ج|دج)\b/i;

  // Field labels that name what comes next. Arabic, French, English.
  var CODE_LABEL  = /(رمز\s*المنتج|رمز|code\s*(?:produit|article)?|r[ée]f[ée]rence|ref\b|r[ée]f\b|article|product\s*code|item\s*code)/i;
  var NAME_LABEL  = /(اسم\s*المنتج|nom\s*du\s*produit|nom\b|product\s*name|d[ée]signation|libell[ée])/i;
  var BRAND_LABEL = /(marque|brand|ماركة)/i;

  // Never a code, name or price.
  var NOISE_RE = new RegExp([
    "made\\s*in", "fabriqu", "الجزائر", "صنع",
    "algeri[ae]", "algérie", "china", "turkey", "turquie",
    "\\d{1,3}\\s*%",                       // 80% polyester
    "polyester", "coton", "cotton", "viscose", "elastha?ne", "spandex", "laine", "wool",
    "تعليمات", "العناية", "غسيل",
    "wash", "lavage", "laver", "bleach", "javel", "repass", "iron",
    "tumble", "s[ée]chage", "dry\\s*clean", "nettoyage",
    "instructions?", "care\\b", "entretien",
    "taille", "^size$", "^sz$",
    "www\\.", "@", "\\.com", "tel[:. ]", "t[ée]l[:. ]"
  ].join("|"), "i");

  // Marketing prose — long, many words, no digits.
  function isProse(t){
    var words = t.split(/\s+/).filter(Boolean);
    return words.length >= 6 && !/\d/.test(t);
  }

  /* Brand blocks are printed on almost every tag and read like a name:
     short, letters only, often uppercase. They must never become the
     product name. "PYJAMA DZ" is the trap — it contains a garment word
     AND is the brand, so the brand markers win. */
  var BRAND_RE = /(fashion|boutique|collection|couture|\bdz\b|\bsarl\b|\beurl\b|\bco\.?\b|®|™)/i;

  var GARMENT_RE = new RegExp([
    "robe", "pull", "pyjama", "chemise", "pantalon", "jupe", "veste", "manteau",
    "short", "ensemble", "surv[ée]tement", "t-?shirt", "tshirt", "polo", "gilet",
    "sweat", "hoodie", "jean", "legging", "body", "combinaison", "peignoir",
    "underwear", "sous-?v[êe]tement", "brassiere", "boxer", "slip", "chaussette",
    "socks", "dress", "shirt", "trousers", "jacket", "coat", "skirt", "blouse",
    "روب", "بيجاما", "قميص", "بنطلون", "فستان", "سترة"
  ].join("|"), "i");

  /* ---------- helpers ---------- */

  function clean(s){
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  }
  function digitsOf(s){ return String(s).replace(/\D/g, ""); }

  function priceIn(text){
    var m = String(text).match(PRICE_RE);
    if(!m) return null;
    var n = Number(m[1].replace(/[^\d]/g, ""));
    if(!isFinite(n) || n <= 0 || n > 10000000) return null;
    return n;
  }

  /* Centre-to-centre distance between a line and the barcode, as a
     fraction of the image diagonal. 0 = on top of it, 1 = far corner. */
  function distanceToBarcode(line, box){
    if(!box || !line.box) return 0.5;                // unknown: neutral
    var lx = line.box.x + line.box.w / 2;
    var ly = line.box.y + line.box.h / 2;
    var bx = box.x + box.w / 2;
    var by = box.y + box.h / 2;
    var dx = lx - bx, dy = ly - by;
    return Math.min(1, Math.sqrt(dx * dx + dy * dy) / Math.SQRT2);
  }

  /* Group words into lines when no line structure was supplied. */
  function wordsToLines(words){
    var sorted = words.slice().sort(function(a, b){
      return (a.y - b.y) || (a.x - b.x);
    });
    var lines = [], cur = null;
    for(var i = 0; i < sorted.length; i++){
      var w = sorted[i];
      var mid = w.y + w.h / 2;
      if(cur && mid >= cur.top && mid <= cur.bottom){
        cur.words.push(w);
        cur.top = Math.min(cur.top, w.y);
        cur.bottom = Math.max(cur.bottom, w.y + w.h);
      } else {
        cur = { words: [w], top: w.y, bottom: w.y + w.h };
        lines.push(cur);
      }
    }
    return lines.map(function(l){
      var ws = l.words.sort(function(a, b){ return a.x - b.x; });
      var x0 = Math.min.apply(null, ws.map(function(w){ return w.x; }));
      var y0 = Math.min.apply(null, ws.map(function(w){ return w.y; }));
      var x1 = Math.max.apply(null, ws.map(function(w){ return w.x + w.w; }));
      var y1 = Math.max.apply(null, ws.map(function(w){ return w.y + w.h; }));
      var conf = ws.reduce(function(s, w){ return s + (w.conf == null ? 80 : w.conf); }, 0) / ws.length;
      return {
        text: clean(ws.map(function(w){ return w.text; }).join(" ")),
        box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
        conf: conf
      };
    });
  }

  /* Accept words, ready-made lines, or plain strings. */
  function normaliseLines(input){
    if(input.words && input.words.length) return wordsToLines(input.words);
    if(input.lines && input.lines.length){
      return input.lines.map(function(l, i){
        if(typeof l === "string"){
          // No geometry: fake a reading-order column so ordering still works.
          return { text: clean(l), box: null, conf: 80, order: i };
        }
        return { text: clean(l.text), box: l.box || null, conf: l.conf == null ? 80 : l.conf, order: i };
      }).filter(function(l){ return l.text; });
    }
    if(typeof input.text === "string"){
      return input.text.split(/\r?\n/).map(clean).filter(Boolean)
        .map(function(t, i){ return { text: t, box: null, conf: 80, order: i }; });
    }
    return [];
  }

  /* The line that a field label points at: the next non-empty line in
     reading order, or — when geometry exists — the nearest line below
     or to the side of the label that is not itself a label. */
  function valueFor(lines, idx){
    var label = lines[idx];
    // same line: "Réf: BASKAT Z8-1"
    var inline = label.text.replace(CODE_LABEL, "").replace(NAME_LABEL, "")
                           .replace(BRAND_LABEL, "").replace(/^[\s:.\-–—]+/, "").trim();
    if(inline.length >= 2) return { line: label, text: inline, inline: true };

    for(var j = idx + 1; j < lines.length; j++){
      var c = lines[j];
      if(!c.text) continue;
      if(CODE_LABEL.test(c.text) || NAME_LABEL.test(c.text) || BRAND_LABEL.test(c.text)) continue;
      if(NOISE_RE.test(c.text)) continue;
      return { line: c, text: c.text, inline: false };
    }
    return null;
  }

  /* Strip an Arabic half from "Robe / روب" and keep what is printable. */
  function tidyValue(t){
    var parts = String(t).split(/\s*[\/|]\s*/);
    for(var i = 0; i < parts.length; i++){
      if(/[A-Za-z0-9]/.test(parts[i])) return clean(parts[i]);
    }
    return clean(t);
  }

  /* A product name is often printed on two stacked lines — "HEAT"
     above "UNDERWEAR". OCR returns those separately, so build merged
     candidates for neighbouring lines that read like one phrase:
     letters only, vertically adjacent, roughly centred on each other. */
  function buildStacks(lines, ctx){
    var out = [];
    for(var i = 0; i + 1 < lines.length; i++){
      var a = lines[i], b = lines[i + 1];
      if(ctx.priceLines.indexOf(a) > -1 || ctx.priceLines.indexOf(b) > -1) continue;
      if(NOISE_RE.test(a.text) || NOISE_RE.test(b.text)) continue;
      if(CODE_LABEL.test(a.text) || NAME_LABEL.test(a.text) || BRAND_LABEL.test(a.text)) continue;
      if(/\d/.test(a.text) || /\d/.test(b.text)) continue;          // names here carry no digits
      if(a.text.split(/\s+/).length > 3 || b.text.split(/\s+/).length > 3) continue;

      if(a.box && b.box){
        var gap = b.box.y - (a.box.y + a.box.h);
        var tall = Math.max(a.box.h, b.box.h);
        if(gap < -tall || gap > tall * 1.4) continue;                // not adjacent
        var ca = a.box.x + a.box.w / 2, cb = b.box.x + b.box.w / 2;
        if(Math.abs(ca - cb) > 0.22) continue;                       // not stacked
      } else if(!(a.order != null && b.order === a.order + 1)){
        continue;                                                    // no geometry: reading order
      }

      var merged = clean(a.text + " " + b.text);
      if(merged.length > 34) continue;
      out.push({
        text: merged,
        box: a.box && b.box ? {
          x: Math.min(a.box.x, b.box.x),
          y: a.box.y,
          w: Math.max(a.box.x + a.box.w, b.box.x + b.box.w) - Math.min(a.box.x, b.box.x),
          h: (b.box.y + b.box.h) - a.box.y
        } : null,
        conf: Math.min(a.conf == null ? 80 : a.conf, b.conf == null ? 80 : b.conf),
        stacked: true,
        parts: [a, b]
      });
    }
    return out;
  }

  /* ---------- scoring ---------- */

  function scoreProductCode(line, ctx){
    var t = line.text;
    var s = 0, why = [];

    if(ctx.priceLines.indexOf(line) > -1) return { score: -100, why: ["is a price"] };
    if(NOISE_RE.test(t))                  return { score: -100, why: ["care / composition text"] };
    if(isProse(t))                        return { score: -100, why: ["marketing prose"] };

    var d = digitsOf(t);
    // The digits printed under the bars are not the product code.
    if(ctx.barcode && d === ctx.barcode)  return { score: -100, why: ["equals the barcode"] };
    if(!ctx.barcode && /^\d{11,14}$/.test(d) && d.length === t.replace(/\s/g, "").length){
      return { score: -60, why: ["looks like a barcode number"] };
    }

    if(ctx.codeLabelled === line){ s += 60; why.push("named by a code field label"); }

    var words = t.split(/\s+/).filter(Boolean);
    if(words.length > 4)  { s -= 25; why.push("too many words"); }
    if(t.length > 24)     { s -= 20; why.push("too long"); }
    if(t.length < 2)      { s -= 40; why.push("too short"); }

    var hasDigit  = /\d/.test(t);
    var hasLetter = /[A-Za-z]/.test(t);
    var hasSep    = /[-_.]/.test(t);

    if(hasDigit && hasLetter) { s += 26; why.push("letters and digits"); }
    if(hasSep && hasDigit)    { s += 10; why.push("has a separator"); }
    // A bare short number near the bars is a very common reference (7630).
    if(!hasLetter && /^\d{3,6}$/.test(d) && d === t.replace(/\s/g, "")){
      s += 24; why.push("short numeric reference");
    }
    if(t === t.toUpperCase() && hasLetter){ s += 6; why.push("uppercase"); }
    if(t.length >= 3 && t.length <= 14)   { s += 8; why.push("compact"); }

    // Closer to the barcode is more likely to be its reference.
    var dist = distanceToBarcode(line, ctx.barcodeBox);
    s += Math.round((1 - dist) * 18);
    if(ctx.barcodeBox) why.push("distance " + dist.toFixed(2));

    if(GARMENT_RE.test(t) && !hasDigit){ s -= 18; why.push("reads as a garment name"); }

    s += Math.round(((line.conf == null ? 80 : line.conf) - 80) / 5);
    return { score: s, why: why };
  }

  function scoreProductName(line, ctx){
    var t = line.text;
    var s = 0, why = [];

    if(ctx.priceLines.indexOf(line) > -1) return { score: -100, why: ["is a price"] };
    if(NOISE_RE.test(t))                  return { score: -100, why: ["care / composition text"] };
    if(isProse(t))                        return { score: -100, why: ["marketing prose"] };
    if(ctx.barcode && digitsOf(t) === ctx.barcode) return { score: -100, why: ["equals the barcode"] };

    if(ctx.nameLabelled === line){ s += 60; why.push("named by a name field label"); }

    var words = t.split(/\s+/).filter(Boolean);
    var letters = (t.match(/[A-Za-z؀-ۿ]/g) || []).length;
    var digits  = (t.match(/\d/g) || []).length;

    if(!letters) return { score: -100, why: ["no letters"] };
    // a brand block is not the product, even when it contains a garment word
    if(ctx.nameLabelled !== line && BRAND_RE.test(t)){
      return { score: -70, why: ["reads as the brand"] };
    }

    if(GARMENT_RE.test(t)){ s += 34; why.push("known garment word"); }
    if(letters >= digits * 2){ s += 14; why.push("mostly letters"); }
    if(digits > letters){ s -= 24; why.push("mostly digits"); }
    if(words.length >= 1 && words.length <= 4){ s += 10; why.push("short phrase"); }
    if(words.length > 5){ s -= 25; why.push("too many words"); }
    if(t.length > 34){ s -= 20; why.push("too long"); }

    // A line already taken as the product code is a poor name.
    if(ctx.chosenCode && t.toUpperCase() === String(ctx.chosenCode).toUpperCase()){
      s -= 30; why.push("already used as the code");
    }
    if(ctx.brandLine === line){ s -= 30; why.push("is the brand"); }

    s += Math.round(((line.conf == null ? 80 : line.conf) - 80) / 5);
    return { score: s, why: why };
  }

  /* ---------- main ---------- */

  function parse(input){
    input = input || {};
    var lines = normaliseLines(input);
    var barcode = input.barcode ? digitsOf(input.barcode) : null;
    var barcodeBox = input.barcodeBox || null;

    var out = {
      barcode: input.barcode || null,
      productCode: null,
      productName: null,
      price: null,
      brand: null,
      confidence: 0,
      lines: lines.map(function(l){ return l.text; })
    };
    if(!lines.length) return out;

    /* --- price: deterministic, wins over every other reading --- */
    var priceLines = [];
    for(var i = 0; i < lines.length; i++){
      var p = priceIn(lines[i].text);
      if(p !== null){
        priceLines.push(lines[i]);
        if(out.price === null || p > out.price) out.price = p;
      }
    }

    /* --- explicit field labels, highest authority --- */
    var codeLabelled = null, nameLabelled = null, brandLine = null;
    for(i = 0; i < lines.length; i++){
      var t = lines[i].text;
      if(priceLines.indexOf(lines[i]) > -1) continue;
      if(!codeLabelled && CODE_LABEL.test(t)){
        var v = valueFor(lines, i);
        if(v){ codeLabelled = v.line; codeLabelled.__override = tidyValue(v.text); }
      }
      if(!nameLabelled && NAME_LABEL.test(t)){
        var v2 = valueFor(lines, i);
        if(v2){ nameLabelled = v2.line; nameLabelled.__override = tidyValue(v2.text); }
      }
      if(!brandLine && BRAND_LABEL.test(t)){
        var v3 = valueFor(lines, i);
        if(v3){ brandLine = v3.line; out.brand = tidyValue(v3.text); }
      }
    }
    // no "Marque:" label, but a line carries brand markers
    if(!brandLine){
      for(i = 0; i < lines.length; i++){
        if(priceLines.indexOf(lines[i]) > -1) continue;
        if(NOISE_RE.test(lines[i].text)) continue;
        if(BRAND_RE.test(lines[i].text) && /[A-Za-z]/.test(lines[i].text)){
          brandLine = lines[i];
          out.brand = tidyValue(lines[i].text);
          break;
        }
      }
    }

    var ctx = {
      barcode: barcode, barcodeBox: barcodeBox, priceLines: priceLines,
      codeLabelled: codeLabelled, nameLabelled: nameLabelled,
      brandLine: brandLine, chosenCode: null
    };

    /* --- product code --- */
    var best = null, bestScore = -1e9, scores = [];
    for(i = 0; i < lines.length; i++){
      var r = scoreProductCode(lines[i], ctx);
      scores.push({ text: lines[i].text, score: r.score, why: r.why });
      if(r.score > bestScore){ bestScore = r.score; best = lines[i]; }
    }
    if(best && bestScore > 8){
      out.productCode = tidyValue(best.__override || best.text);
      ctx.chosenCode = out.productCode;
    }
    var codeScore = bestScore;

    /* --- product name: single lines plus stacked pairs --- */
    var nameCandidates = lines.concat(buildStacks(lines, ctx));
    var bestN = null, bestNScore = -1e9;
    for(i = 0; i < nameCandidates.length; i++){
      var cand = nameCandidates[i];
      if(cand === best && !nameLabelled) continue;          // do not reuse the code line
      if(cand.stacked && cand.parts.indexOf(best) > -1) continue;
      var rn = scoreProductName(cand, ctx);
      // a merged pair beats either half on its own when it reads as one phrase
      if(cand.stacked) rn.score += 8;
      if(rn.score > bestNScore){ bestNScore = rn.score; bestN = cand; }
    }
    if(bestN && bestNScore > 12){
      out.productName = tidyValue(bestN.__override || bestN.text);
    }

    /* --- confidence: how sure are we of the pieces we return --- */
    var conf = 0.4;
    if(out.barcode) conf += 0.2;
    if(out.price !== null) conf += 0.12;
    if(out.productCode){
      conf += 0.1;
      if(codeLabelled === best) conf += 0.14;             // an explicit label is strong
      else if(codeScore > 45) conf += 0.08;
      else if(codeScore < 22) conf -= 0.12;               // scraped through
    } else conf -= 0.18;
    if(out.productName) conf += 0.06;
    out.confidence = Math.max(0, Math.min(1, Math.round(conf * 100) / 100));

    out.debug = { codeScore: codeScore, nameScore: bestNScore, scores: scores };
    return out;
  }

  global.LabelParser = { parse: parse, priceIn: priceIn, NOISE_RE: NOISE_RE };

})(typeof window !== "undefined" ? window : globalThis);
