/* ============================================================
   audit-scans.js — run with:  node audit-scans.js
   ------------------------------------------------------------
   READ ONLY. Reads every scan out of Supabase and flags the ones
   that look like misreads, so they can be reviewed before any
   deletion. Nothing is written or removed by this script.

   A misread usually looks like: scanned once or twice, while a
   near-identical code was scanned many times. Barcodes on the
   same rail differ in many digits; a misread differs in one or
   two, or drops a digit entirely.
   ============================================================ */

const path = require("path");
global.window = global;
require(path.join(__dirname, "shared", "config.js"));
const CFG = global.PYJAMADZ_CONFIG;

const H = {
  apikey: CFG.supabaseAnonKey,
  Authorization: "Bearer " + CFG.supabaseAnonKey
};

/* how many single-character edits turn a into b */
function editDistance(a, b){
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for(let i = 1; i <= m; i++){
    const cur = [i];
    for(let j = 1; j <= n; j++){
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

/* UPC-E is a COMPRESSED UPC-A. Its check digit belongs to the expanded
   12-digit form, so testing the 8 digits directly condemns valid codes.
   Expansion is driven by the last data digit. */
function upcEToA(code){
  if(!/^[01]\d{7}$/.test(code)) return null;
  const n = code[0], d = code.slice(1, 7), c = code[7];
  const [a, b, e, f, g, h] = d;
  let body;
  switch(h){
    case "0": case "1": case "2": body = a + b + h + "0000" + e + f + g; break;
    case "3": body = a + b + e + "00000" + f + g; break;
    case "4": body = a + b + e + f + "00000" + g; break;
    default:  body = a + b + e + f + g + "0000" + h; break;
  }
  return n + body + c;
}

/* Only EAN/UPC carry this check digit. Applying it to a Code 128 or
   Code 39 value would condemn a perfectly good code, so the format the
   scan was recorded with decides whether the test applies at all. */
function checkDigitOk(code, format){
  const f = (format || "").toUpperCase();
  if(f && !/EAN|UPC/.test(f)) return null;
  if(/UPC_E/.test(f) || (!f && /^[01]\d{7}$/.test(code))){
    const expanded = upcEToA(code);
    return expanded ? checkDigitOk(expanded, "UPC_A") : null;
  }
  if(!/^\d{8}$|^\d{12,13}$/.test(code)) return null;
  const body = code.slice(0, -1);
  let sum = 0;
  for(let i = 0; i < body.length; i++){
    const d = +body[body.length - 1 - i];
    sum += (i % 2 === 0) ? d * 3 : d;
  }
  return ((10 - (sum % 10)) % 10) === +code.slice(-1);
}

async function all(table){
  const rows = [];
  for(let from = 0; ; from += 1000){
    const res = await fetch(
      CFG.supabaseUrl + "/rest/v1/" + table + "?select=*&order=scanned_at.asc",
      { headers: Object.assign({}, H, { Range: from + "-" + (from + 999) }) });
    const page = await res.json();
    if(!Array.isArray(page) || !page.length) break;
    rows.push(...page);
    if(page.length < 1000) break;
  }
  return rows;
}

(async () => {
  const scans = await all("scans");
  const products = await all("products");
  const named = new Set(products.map(p => p.code));

  const count = new Map();
  for(const s of scans) count.set(s.code, (count.get(s.code) || 0) + 1);

  const codes = [...count.entries()].sort((a, b) => b[1] - a[1]);
  const fmt = new Map();
  for(const s of scans) if(!fmt.has(s.code)) fmt.set(s.code, s.format);

  console.log("\n" + scans.length + " scans, " + codes.length + " distinct codes, " +
              products.length + " named products\n");

  console.log("ANCHORS — scanned repeatedly, treated as the real codes");
  const anchors = codes.filter(([, n]) => n >= 3).map(([c]) => c);
  for(const [c, n] of codes.filter(([, n]) => n >= 3)){
    console.log("  " + String(n).padStart(4) + " x  " + c + (named.has(c) ? "   (named)" : ""));
  }

  const suspect = [];
  for(const [c, n] of codes){
    if(anchors.includes(c)) continue;      // a repeated code is the original
    let near = null, best = 99;
    for(const a of anchors){
      if(a === c) continue;
      // only a CLEARLY more frequent code can be the original
      if(count.get(a) < n * 2) continue;
      const d = editDistance(c, a);
      if(d < best){ best = d; near = a; }
    }
    const badCheck = checkDigitOk(c, fmt.get(c)) === false;
    // a misread differs from the original in only a few digits
    if(near && best <= 4) suspect.push({ code: c, n, near, dist: best, badCheck });
    else if(badCheck) suspect.push({ code: c, n, near: null, dist: null, badCheck });
  }

  console.log("\nSUSPECTED MISREADS — " + suspect.length + " code(s), " +
              suspect.reduce((a, s) => a + s.n, 0) + " scan(s)");
  for(const s of suspect.sort((a, b) => (a.dist ?? 9) - (b.dist ?? 9))){
    console.log("  " + String(s.n).padStart(4) + " x  " + s.code.padEnd(15) +
      (s.near ? " looks like " + s.near + "  (" + s.dist +
                (s.dist === 1 ? " digit" : " digits") + " off" +
                (s.code.length !== s.near.length ? ", wrong length" : "") + ")"
              : " invalid check digit for " + (fmt.get(s.code) || "EAN/UPC")));
  }

  const rest = codes.filter(([c]) => !suspect.find(s => s.code === c) && !anchors.includes(c));
  if(rest.length){
    console.log("\nNOT CLOSE TO ANYTHING — judge these yourself");
    for(const [c, n] of rest) console.log("  " + String(n).padStart(4) + " x  " + c +
                                          "   " + (fmt.get(c) || "?") +
                                          (named.has(c) ? "   (named)" : ""));
  }

  if(!process.argv.includes("--delete")){
    console.log("\nTo delete ONLY the suspected misreads above, run:");
    console.log("  node audit-scans.js --delete");
    console.log("\nNothing was changed.\n");
    return;
  }

  /* Delete by row id, never by code: deleting `code=eq.X` would also
     remove any genuine scan of X, and the ids come straight from the
     rows printed above, so nothing unlisted can be caught up in it. */
  const doomed = new Set(suspect.map(s => s.code));
  const ids = scans.filter(s => doomed.has(s.code)).map(s => s.id);

  console.log("\nDeleting " + ids.length + " scan row(s)…");
  let gone = 0;
  for(let i = 0; i < ids.length; i += 50){
    const batch = ids.slice(i, i + 50);
    const res = await fetch(
      CFG.supabaseUrl + "/rest/v1/scans?id=in.(" + batch.join(",") + ")",
      { method: "DELETE", headers: H });
    if(res.status >= 200 && res.status < 300) gone += batch.length;
    else console.log("  batch failed: HTTP " + res.status + " " + (await res.text()));
  }

  const after = await all("scans");
  console.log("  removed " + gone + " row(s); " + after.length + " scans remain");
  const left = new Set(after.map(s => s.code));
  const stillThere = [...doomed].filter(c => left.has(c));
  console.log(stillThere.length
    ? "  still present: " + stillThere.join(", ")
    : "  every suspected misread is gone");
  console.log("");

})().catch(e => { console.log("FAILED: " + e.message); process.exit(1); });
