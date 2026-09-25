/* ============================================================
   Shared helpers — used by both the scanner page and the
   database page. Loaded before scanner.js / database.js.
   ============================================================ */

(function(global){
  "use strict";

  function esc(s){
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function(m){
      return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[m];
    });
  }

  function money(v){
    return (typeof v === "number" && isFinite(v)) ? v.toLocaleString("fr-DZ") : "—";
  }

  function clock(iso){
    var d = iso ? new Date(iso) : new Date();
    if(isNaN(d.getTime())) return "--:--";
    return ("0"+d.getHours()).slice(-2) + ":" + ("0"+d.getMinutes()).slice(-2);
  }

  function stamp(iso){
    var d = iso ? new Date(iso) : new Date();
    if(isNaN(d.getTime())) return "";
    return ("0"+d.getDate()).slice(-2) + "/" + ("0"+(d.getMonth()+1)).slice(-2) + "/" + d.getFullYear() +
           " " + clock(iso);
  }

  /* A code reopened from a list carries no format — infer it from length. */
  function guessFormat(code){
    if(!/^\d+$/.test(code)) return "";
    if(code.length === 13) return "EAN_13";
    if(code.length === 12) return "UPC_A";
    if(code.length === 8)  return "EAN_8";
    return "";
  }

  function expectedCheck(body){
    var sum = 0, n = body.length;
    for(var i=0;i<n;i++){
      var d = +body.charAt(n-1-i);
      sum += (i % 2 === 0) ? d*3 : d;
    }
    return (10 - (sum % 10)) % 10;
  }

  function checksumState(code, format){
    var f = (format||"").toUpperCase();
    var lenOk = (f.indexOf("EAN_13")>-1 && code.length===13) ||
                (f.indexOf("EAN_8")>-1 && code.length===8) ||
                (f.indexOf("UPC_A")>-1 && code.length===12) ||
                (!f && (code.length===13 || code.length===12 || code.length===8));
    if(!lenOk || !/^\d+$/.test(code)) return null;
    return expectedCheck(code.slice(0,-1)) === +code.slice(-1);
  }

  /* ---------- EAN-13 bar pattern ---------- */
  var L = ["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
  var G = ["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"];
  var R = ["1110010","1100110","1101100","1000010","1011100","1001110","1010000","1000100","1001000","1110100"];
  var PARITY = ["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"];

  function ean13Pattern(code){
    if(!/^\d{13}$/.test(code)) return null;
    var par = PARITY[+code.charAt(0)], out = "101";
    for(var i=1;i<=6;i++){
      var d = +code.charAt(i);
      out += (par.charAt(i-1) === "L") ? L[d] : G[d];
    }
    out += "01010";
    for(var j=7;j<13;j++) out += R[+code.charAt(j)];
    return out + "101";
  }

  function drawBars(svg, code){
    var p = ean13Pattern(code);
    svg.innerHTML = "";
    if(!p){ svg.hidden = true; return; }
    svg.hidden = false;
    var n = p.length, h = 70, guard = [0,1,2,45,46,47,48,49,92,93,94], frag = "";
    svg.setAttribute("viewBox", "0 0 " + n + " " + (h+10));
    svg.setAttribute("preserveAspectRatio","none");
    for(var i=0;i<n;i++){
      if(p.charAt(i) === "1"){
        frag += '<rect x="'+i+'" y="0" width="1" height="'+(guard.indexOf(i)>-1?h+8:h)+'" fill="currentColor"/>';
      }
    }
    svg.innerHTML = frag;
  }

  /* ---------- grouping ----------
     One line per barcode with a quantity, derived from the raw scan
     rows. Grouping happens here rather than in storage so that two
     phones scanning at once can never overwrite each other's count. */
  function groupScans(scans){
    var map = {}, order = [];
    for(var i=0;i<scans.length;i++){
      var e = scans[i], c = e.code;
      if(!map[c]){
        map[c] = { code:c, qty:0, ids:[], at:e.at, price:e.price, name:e.name, sku:e.sku, brand:e.brand };
        order.push(c);          // scans arrive newest-first, so order is too
      }
      var g = map[c];
      g.qty++;
      g.ids.push(e.id);
      if(e.at && (!g.at || e.at > g.at)) g.at = e.at;
    }
    return order.map(function(c){ return map[c]; });
  }

  function unitPrice(g, catalog){
    var it = catalog && catalog[g.code];
    if(it && typeof it.price === "number") return it.price;
    return typeof g.price === "number" ? g.price : null;
  }

  /* Everything the list and the exports need, in one shape. */
  function summarise(scans, catalog){
    var groups = groupScans(scans);
    var rows = [], total = 0, priced = true, pieces = 0;
    for(var i=0;i<groups.length;i++){
      var g = groups[i], it = (catalog && catalog[g.code]) || {};
      var u = unitPrice(g, catalog);
      if(typeof u === "number") total += u * g.qty; else priced = false;
      pieces += g.qty;
      var ref  = it.sku  || g.sku  || "";
      var desc = it.name || g.name || "";
      rows.push({
        code: g.code,
        brand: it.brand || g.brand || "",
        name: desc,
        nameAr: it.nameAr || "",
        sku: ref,
        // the reference is what identifies a product on these tags, so it
        // is the headline; the descriptive name is secondary when present
        ref: ref,
        title: ref || desc || "",
        qty: g.qty,
        unit: u,
        line: (typeof u === "number") ? u * g.qty : null,
        at: g.at,
        ids: g.ids
      });
    }
    return { rows: rows, total: total, priced: priced, pieces: pieces, products: rows.length };
  }

  function csv(rows){
    // reference first: it is what identifies the product
    var out = ["reference,name,brand,barcode,qty,unit_price_da,line_total_da,last_scanned"];
    for(var i=0;i<rows.length;i++){
      var r = rows[i];
      out.push([
        '"' + String(r.sku || "").replace(/"/g,'""') + '"',
        '"' + String(r.name || "").replace(/"/g,'""') + '"',
        '"' + String(r.brand || "").replace(/"/g,'""') + '"',
        r.code,
        r.qty,
        (r.unit == null ? "" : r.unit),
        (r.line == null ? "" : r.line),
        r.at || ""
      ].join(","));
    }
    return out.join("\\r\\n");
  }

  /* Where the other app lives. The two are deployed separately and share
     only the Supabase database, so the link between them is configured
     rather than a relative path. Falls back to a sibling file, which is
     what a single combined deployment uses. */
  function appUrl(kind){
    var cfg = global.PYJAMADZ_CONFIG || {};
    var url = kind === "scanner" ? cfg.scannerUrl : cfg.databaseUrl;
    if(url && typeof url === "string" && url.trim()){
      url = url.trim();
      return /^https?:\/\//i.test(url) ? url : "https://" + url;
    }
    return kind === "scanner" ? "index.html" : "database.html";
  }

  /* True when the two apps are wired to separate deployments. */
  function isSplit(){
    var cfg = global.PYJAMADZ_CONFIG || {};
    return !!((cfg.scannerUrl && cfg.scannerUrl.trim()) ||
              (cfg.databaseUrl && cfg.databaseUrl.trim()));
  }

  /* Map a tap onto the picture. The video is object-fit:contain inside
     its box, so when the stream's shape differs from the box there are
     letterbox bars — mapping from the box rect would aim the camera at
     the wrong part of the scene. Returns 0..1 image coordinates, or
     null when the tap landed on a bar rather than the picture. */
  function pointInImage(rect, vw, vh, clientX, clientY){
    if(!rect || !rect.width || !rect.height || !vw || !vh) return null;
    var scale = Math.min(rect.width / vw, rect.height / vh);
    var dw = vw * scale, dh = vh * scale;
    var ox = rect.left + (rect.width  - dw) / 2;
    var oy = rect.top  + (rect.height - dh) / 2;
    var x = (clientX - ox) / dw;
    var y = (clientY - oy) / dh;
    if(x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x: x, y: y };
  }

  /* Tapping anywhere on the barcode should mean "focus on the barcode",
     so a tap inside (or just outside) its box snaps to the box centre. */
  function snapToBox(point, box, pad){
    if(!point || !box || !box.w || !box.h) return point;
    var p = (pad == null) ? 0.06 : pad;
    if(point.x >= box.x - p && point.x <= box.x + box.w + p &&
       point.y >= box.y - p && point.y <= box.y + box.h + p){
      return { x: box.x + box.w / 2, y: box.y + box.h / 2, snapped: true };
    }
    return point;
  }

  global.PDZ = {
    appUrl: appUrl, isSplit: isSplit,
    pointInImage: pointInImage, snapToBox: snapToBox,
    esc: esc, money: money, clock: clock, stamp: stamp,
    guessFormat: guessFormat, checksumState: checksumState,
    drawBars: drawBars, groupScans: groupScans, unitPrice: unitPrice,
    summarise: summarise, csv: csv
  };

})(typeof window !== "undefined" ? window : globalThis);
