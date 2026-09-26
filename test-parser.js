/* ============================================================
   test-parser.js — run with:  node test-parser.js
   ------------------------------------------------------------
   The SmartLabelParser is a pure function, so it is tested on its
   own, with no DOM and no camera. Covers the three real label
   layouts plus the traps: barcode digits, care text, prose, and
   prices that must never be read as a product code.
   ============================================================ */

const path = require("path");
const g = globalThis;
require(path.join(__dirname, "scanner", "label-parser.js"));
const { parse } = g.LabelParser;

let failures = 0;
function check(name, got, want){
  const keys = Object.keys(want);
  const bad = keys.filter(k => JSON.stringify(got[k]) !== JSON.stringify(want[k]));
  if(bad.length === 0){
    console.log("  PASS  " + name);
    return;
  }
  failures++;
  console.log("  FAIL  " + name);
  bad.forEach(k => console.log("          " + k + ": got " + JSON.stringify(got[k]) +
                              "   want " + JSON.stringify(want[k])));
}

/* A label as OCR returns it, with rough boxes. The barcode box is the
   anchor; y grows downward, all values 0..1 of the cropped region. */
function L(text, x, y, w, h, conf){
  return { text, box: { x, y, w, h }, conf: conf == null ? 88 : conf };
}

console.log("\nSmartLabelParser\n");

/* ---------- TYPE A: explicit Arabic field labels ---------- */
check("TYPE A — labelled fields", parse({
  barcode: "445853470123",
  barcodeBox: { x: 0.10, y: 0.55, w: 0.80, h: 0.14 },
  lines: [
    L("اسم المنتج",    0.30, 0.05, 0.40, 0.06),
    L("Robe / روب",    0.32, 0.13, 0.36, 0.07),
    L("رمز المنتج",    0.30, 0.28, 0.40, 0.06),
    L("BASKAT Z8-1",   0.28, 0.36, 0.44, 0.07),
    L("445853470123",  0.20, 0.71, 0.60, 0.05),
    L("1600 DA",       0.34, 0.84, 0.32, 0.09)
  ]
}), {
  barcode: "445853470123",
  productCode: "BASKAT Z8-1",
  productName: "Robe",
  price: 1600
});

/* ---------- TYPE B: no field labels, short numeric ref ---------- */
check("TYPE B — bare numeric reference", parse({
  barcode: "6111245987453",
  barcodeBox: { x: 0.12, y: 0.10, w: 0.76, h: 0.18 },
  lines: [
    L("6111245987453", 0.22, 0.30, 0.56, 0.05),
    L("7630",          0.40, 0.40, 0.20, 0.08),
    L("1800 DA",       0.34, 0.55, 0.32, 0.10),
    L("HEAT",          0.36, 0.72, 0.28, 0.08),
    L("UNDERWEAR",     0.26, 0.81, 0.48, 0.08)
  ]
}), {
  productCode: "7630",
  productName: "HEAT UNDERWEAR",     // OCR split it across two lines
  price: 1800
});

/* HEAT / UNDERWEAR arrive as two OCR lines; as one line it must be the name */
check("TYPE B — two-word product name", parse({
  barcode: "6111245987453",
  barcodeBox: { x: 0.12, y: 0.10, w: 0.76, h: 0.18 },
  lines: [
    L("7630",           0.40, 0.40, 0.20, 0.08),
    L("1800 DA",        0.34, 0.55, 0.32, 0.10),
    L("HEAT UNDERWEAR", 0.26, 0.75, 0.48, 0.08)
  ]
}), {
  productCode: "7630",
  productName: "HEAT UNDERWEAR",
  price: 1800
});

/* ---------- TYPE C: word + number reference, no name ---------- */
check("TYPE C — 'pull 699'", parse({
  barcode: "6130987112345",
  barcodeBox: { x: 0.12, y: 0.12, w: 0.76, h: 0.18 },
  lines: [
    L("pull 699", 0.32, 0.42, 0.36, 0.09),
    L("2300 DA",  0.34, 0.62, 0.32, 0.10)
  ]
}), {
  productCode: "pull 699",
  price: 2300
});

/* ---------- traps ---------- */

check("a price is never the product code", parse({
  barcode: "1044797380876",
  lines: [L("1950 DA", 0.3, 0.5, 0.3, 0.1)]
}), { productCode: null, price: 1950 });

check("the printed barcode digits are never the product code", parse({
  barcode: "1044797380876",
  lines: [
    L("1044797380876", 0.2, 0.4, 0.6, 0.05),
    L("PULL AR-195",   0.3, 0.5, 0.4, 0.07),
    L("1950 DA",       0.35, 0.62, 0.3, 0.09)
  ]
}), { productCode: "PULL AR-195", price: 1950 });

check("care and composition text is ignored", parse({
  barcode: "4458534760123",
  lines: [
    L("80% POLYESTER 20% COTON", 0.1, 0.2, 0.8, 0.05),
    L("MADE IN ALGERIA",         0.2, 0.28, 0.6, 0.05),
    L("تعليمات العناية",          0.3, 0.36, 0.4, 0.05),
    L("BASKAT Z8-1",             0.3, 0.5, 0.4, 0.07),
    L("1600 DA",                 0.35, 0.65, 0.3, 0.09)
  ]
}), { productCode: "BASKAT Z8-1", price: 1600 });

check("marketing prose never becomes the product name", parse({
  barcode: "4458534760123",
  lines: [
    L("Our Collection Has Been Designed For Comfort", 0.05, 0.2, 0.9, 0.05),
    L("Robe",     0.4, 0.4, 0.2, 0.08),
    L("BASKAT Z8-1", 0.3, 0.52, 0.4, 0.07),
    L("1600 DA",  0.35, 0.68, 0.3, 0.09)
  ]
}), { productCode: "BASKAT Z8-1", productName: "Robe", price: 1600 });

check("the brand block never becomes the product name", parse({
  barcode: "1044797380876",
  barcodeBox: { x: 0.10, y: 0.20, w: 0.80, h: 0.14 },
  lines: [
    L("1044797380876", 0.20, 0.36, 0.60, 0.05),
    L("PULL AR-195",   0.30, 0.46, 0.40, 0.07),
    L("1950 DA",       0.35, 0.60, 0.30, 0.09),
    L("PYJAMA DZ",     0.30, 0.78, 0.40, 0.06),
    L("FASHION",       0.34, 0.86, 0.32, 0.05)
  ]
}), { productCode: "PULL AR-195", productName: null, price: 1950, brand: "PYJAMA DZ" });

check("French 'Réf:' label wins", parse({
  barcode: "6111245987453",
  lines: [
    L("Réf: AB-2290", 0.2, 0.3, 0.6, 0.07),
    L("MODEL-123",    0.25, 0.45, 0.5, 0.07),
    L("1200 DA",      0.35, 0.6, 0.3, 0.09)
  ]
}), { productCode: "AB-2290", price: 1200 });

check("price formats: DZD and دج", parse({
  barcode: null, lines: [L("1800 DZD", 0, 0, 1, 0.1)]
}).price, 1800);
check("price format دج", parse({
  barcode: null, lines: [L("2300 دج", 0, 0, 1, 0.1)]
}).price, 2300);

check("nothing readable -> nulls, low confidence", parse({
  barcode: "4458534760123", lines: []
}), { productCode: null, productName: null, price: null });

/* ---------- confidence behaviour ---------- */
const labelled = parse({
  barcode: "445853470123",
  lines: [
    L("رمز المنتج",  0.3, 0.2, 0.4, 0.05),
    L("BASKAT Z8-1", 0.3, 0.28, 0.4, 0.07),
    L("1600 DA",     0.35, 0.5, 0.3, 0.09)
  ]
});
const scraped = parse({
  barcode: "6130987112345",
  lines: [L("pull 699", 0.3, 0.4, 0.4, 0.08)]
});
if(labelled.confidence > scraped.confidence){
  console.log("  PASS  an explicit field label scores higher than a scraped guess" +
              "  (" + labelled.confidence + " vs " + scraped.confidence + ")");
} else {
  failures++;
  console.log("  FAIL  confidence ordering: labelled " + labelled.confidence +
              " should beat scraped " + scraped.confidence);
}

/* ---------- cross-app linking ----------
   The two apps are deployed separately and meet only in Supabase, so
   the link between them is configured, not a relative path. */
console.log("\nCross-app linking\n");

require(path.join(__dirname, "shared", "common.js"));
const { appUrl, isSplit } = g.PDZ;

function linkCheck(name, cfg, want, wantSplit){
  g.PYJAMADZ_CONFIG = cfg;
  const gotDb = appUrl("database"), gotSc = appUrl("scanner");
  const gotSplit = isSplit();
  const bad = [];
  if(gotDb !== want.database) bad.push("database -> " + gotDb + " want " + want.database);
  if(gotSc !== want.scanner)  bad.push("scanner -> "  + gotSc + " want " + want.scanner);
  if(gotSplit !== wantSplit)  bad.push("isSplit -> "  + gotSplit + " want " + wantSplit);
  if(!bad.length){ console.log("  PASS  " + name); return; }
  failures++;
  console.log("  FAIL  " + name);
  bad.forEach(b => console.log("          " + b));
}

linkCheck("single folder: siblings", {},
  { database: "database.html", scanner: "index.html" }, false);

linkCheck("split: configured addresses",
  { scannerUrl: "https://scan.example.com", databaseUrl: "https://stock.example.com" },
  { database: "https://stock.example.com", scanner: "https://scan.example.com" }, true);

linkCheck("a bare host gets https://",
  { scannerUrl: "scan.example.com", databaseUrl: "stock.example.com" },
  { database: "https://stock.example.com", scanner: "https://scan.example.com" }, true);

linkCheck("whitespace is not a configured address",
  { scannerUrl: "   ", databaseUrl: "" },
  { database: "database.html", scanner: "index.html" }, false);

linkCheck("one side configured still counts as split",
  { databaseUrl: "https://stock.example.com" },
  { database: "https://stock.example.com", scanner: "index.html" }, true);

/* ---------- tap to focus ----------
   Tapping the preview must aim the camera at the spot in the PICTURE.
   The video is object-fit:contain, so when the stream's shape differs
   from its box there are letterbox bars, and mapping from the box rect
   would point the camera at the wrong part of the scene. */
console.log("\nTap to focus\n");

const { pointInImage, snapToBox } = g.PDZ;

function tap(name, rect, vw, vh, cx, cy, want){
  const got = pointInImage(rect, vw, vh, cx, cy);
  const same = (want === null)
    ? got === null
    : got && Math.abs(got.x - want.x) < 0.01 && Math.abs(got.y - want.y) < 0.01;
  if(same){ console.log("  PASS  " + name); return; }
  failures++;
  console.log("  FAIL  " + name);
  console.log("          got  " + (got ? got.x.toFixed(3) + "," + got.y.toFixed(3) : "null"));
  console.log("          want " + (want ? want.x + "," + want.y : "null"));
}

// 800x600 box showing a 16:9 stream -> an 800x450 picture, 75px bars top and bottom
const boxed = { left: 0, top: 0, width: 800, height: 600 };
tap("centre of a letterboxed picture", boxed, 1920, 1080, 400, 300, { x: 0.5, y: 0.5 });
tap("top edge of the picture",         boxed, 1920, 1080, 400, 75,  { x: 0.5, y: 0 });
tap("a tap on the black bar is ignored", boxed, 1920, 1080, 400, 20, null);
tap("bottom bar is ignored",             boxed, 1920, 1080, 400, 580, null);

// when the shapes match there is no letterbox at all
const exact = { left: 0, top: 0, width: 900, height: 600 };
tap("no letterbox: straight mapping", exact, 1800, 1200, 225, 150, { x: 0.25, y: 0.25 });

// the box rect is offset on the page — the offset must be removed
const offset = { left: 100, top: 50, width: 800, height: 450 };
tap("page offset is accounted for", offset, 1920, 1080, 500, 275, { x: 0.5, y: 0.5 });

tap("a zero-size box yields nothing", { left:0, top:0, width:0, height:0 },
    1920, 1080, 10, 10, null);

/* Tapping anywhere on the barcode means "focus on the barcode". */
function snap(name, point, box, want){
  const got = snapToBox(point, box);
  const ok2 = Math.abs(got.x - want.x) < 0.01 && Math.abs(got.y - want.y) < 0.01 &&
              !!got.snapped === !!want.snapped;
  if(ok2){ console.log("  PASS  " + name); return; }
  failures++;
  console.log("  FAIL  " + name);
  console.log("          got  " + got.x.toFixed(3) + "," + got.y.toFixed(3) +
              " snapped=" + !!got.snapped);
  console.log("          want " + want.x + "," + want.y + " snapped=" + !!want.snapped);
}

const bars = { x: 0.10, y: 0.40, w: 0.60, h: 0.12 };
snap("a tap inside the bars snaps to their centre",
     { x: 0.20, y: 0.43 }, bars, { x: 0.40, y: 0.46, snapped: true });
snap("a tap just outside still counts as the bars",
     { x: 0.08, y: 0.38 }, bars, { x: 0.40, y: 0.46, snapped: true });
snap("a tap well away is left alone",
     { x: 0.90, y: 0.90 }, bars, { x: 0.90, y: 0.90, snapped: false });
snap("no known barcode: the tap is left alone",
     { x: 0.30, y: 0.30 }, null, { x: 0.30, y: 0.30, snapped: false });

/* ---------- misread detection ----------
   Taken straight from the live database: 9311460226710 was scanned 80
   times and came back once as 9001460226710, whose EAN-13 check digit
   is ALSO valid. Only the scan history separates them. */
console.log("\nMisread detection\n");

const { nearDuplicate, editDistance } = g.PDZ;

const history = {
  "9311460226710": 80,
  "1038917562297": 26,
  "4040917562297": 21,
  "1044797380876": 3
};

function mis(name, code, want){
  const got = nearDuplicate(code, history);
  const ok2 = want === null ? got === null : (got && got.near === want);
  if(ok2){ console.log("  PASS  " + name); return; }
  failures++;
  console.log("  FAIL  " + name);
  console.log("          got  " + (got ? got.near + " (" + got.dist + " off)" : "null"));
  console.log("          want " + (want || "null"));
}

mis("real misread from the database",      "9001460226710", "9311460226710");
mis("another, 2 digits off",               "9311460226772", "9311460226710");
mis("misread of the Pull tag",             "1044758380877", "1044797380876");
mis("a code already in history is fine",   "9311460226710", null);
mis("a genuinely different code passes",   "6111245987453", null);
mis("a rarely-seen code is no anchor",     "1044797380875", "1044797380876");

if(editDistance("9311460226710", "9001460226710") !== 2){
  failures++; console.log("  FAIL  editDistance is wrong");
} else console.log("  PASS  editDistance counts digit changes");

// a code seen only twice must not be treated as established
if(nearDuplicate("1234567890128", { "1234567890127": 2 }) !== null){
  failures++; console.log("  FAIL  anchored on a code seen only twice");
} else console.log("  PASS  needs an established code to anchor against");

console.log("\n" + (failures ? failures + " FAILURE(S)\n" : "All checks passed\n"));
process.exit(failures ? 1 : 0);
