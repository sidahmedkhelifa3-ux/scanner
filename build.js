/* ============================================================
   build.js — run with:  node build.js
   ------------------------------------------------------------
   Produces TWO independently deployable apps from this one source
   folder:

     dist/scanner/    the phone app — camera, decoding, OCR
     dist/database/   the list, totals, printing, PDF

   They share nothing at runtime except the Supabase project named
   in config.js. That is the whole point of splitting them: the
   shop phone and the office laptop are separate deployments that
   meet in the database.

   The source folder stays exactly as it is, so the test suites
   keep running against it. Nothing here is a bundler — it copies
   files and renames one entry point.
   ============================================================ */

const fs = require("fs");
const path = require("path");

const SRC  = __dirname;
const DIST = path.join(SRC, "dist");

/* Source layout:
     scanner/    the phone app's own files
     database/   the list app's own files
     shared/     edited once, copied into both
   The pages reference shared files as ../shared/x.js so they work
   straight from source. The build flattens that prefix away, because
   a deployed app has every file sitting next to its index.html. */
const SHARED_DIR = "shared";
const SHARED = ["styles.css", "config.js", "common.js", "store.js"];

const APPS = {
  scanner: {
    dir: "scanner",
    own: ["index.html", "decoder.js", "label-parser.js", "ocr.js", "scanner.js"],
    blurb: "camera, barcode decoding, on-device OCR"
  },
  database: {
    dir: "database",
    own: ["index.html", "database.js"],
    blurb: "list, totals, Imprimer, Export PDF"
  }
};

/* Clear the output without demanding the folder itself be removable.
   Windows hands out EPERM on a directory that Explorer, a sync client or
   a virus scanner happens to be holding — and failing the whole build
   over that is useless, since every file is rewritten anyway. */
function rmrf(p){
  if(!fs.existsSync(p)) return;
  try{
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return;
  }catch(e){
    if(e.code !== "EPERM" && e.code !== "EBUSY" && e.code !== "ENOTEMPTY") throw e;
  }
  // fall back to emptying it file by file, keeping the directory
  var stuck = 0;
  (function empty(dir){
    for(const e of fs.readdirSync(dir, { withFileTypes: true })){
      const f = path.join(dir, e.name);
      try{
        if(e.isDirectory()){ empty(f); fs.rmdirSync(f); }
        else fs.unlinkSync(f);
      }catch(err){ stuck++; }
    }
  })(p);
  if(stuck) console.log("  (kept " + p + " — " + stuck + " item(s) locked by another program)\n");
}

/* Copy, flattening the ../shared/ prefix out of HTML so the deployed
   app finds every file beside its own index.html. */
function copy(from, to){
  if(/\.html$/i.test(from)){
    const html = fs.readFileSync(from, "utf8").split("../" + SHARED_DIR + "/").join("");
    fs.writeFileSync(to, html, "utf8");
  } else {
    fs.copyFileSync(from, to);
  }
  return fs.statSync(to).size;
}

let failed = false;
rmrf(DIST);
fs.mkdirSync(DIST, { recursive: true });

console.log("\nBuilding two deployable apps\n");

for(const [name, app] of Object.entries(APPS)){
  const out = path.join(DIST, name);
  fs.mkdirSync(out, { recursive: true });

  const all = app.own.map(f => [path.join(app.dir, f), f])
       .concat(SHARED.map(f => [path.join(SHARED_DIR, f), f]));
  let bytes = 0, n = 0;

  for(const [src, dst] of all){
    const from = path.join(SRC, src);
    if(!fs.existsSync(from)){
      console.log("  MISSING  " + src + "  (app: " + name + ")");
      failed = true;
      continue;
    }
    bytes += copy(from, path.join(out, dst));
    n++;
  }

  console.log("  " + app.dir + "/ + " + SHARED_DIR + "/  ->  dist/" + name + "/");
  console.log("     " + app.blurb);
  console.log("     " + n + " files, " + Math.round(bytes / 1024) + " KB");
  console.log("");
}

/* A page must not reference a file its own app does not ship. */
for(const name of Object.keys(APPS)){
  const out = path.join(DIST, name);
  const page = fs.readFileSync(path.join(out, "index.html"), "utf8");
  const here = fs.readdirSync(out);
  const refs = [
    ...[...page.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]),
    ...[...page.matchAll(/<link[^>]+href="([^"]+)"/g)].map(m => m[1])
  ].filter(r => !/^(https?:)?\/\//.test(r) && !r.startsWith("data:"));

  for(const r of refs){
    if(!here.includes(r)){
      console.log("  BROKEN   dist/" + name + "/index.html references " + r + ", which is not in that app");
      failed = true;
    }
  }
}

if(failed){
  console.log("\nBuild finished WITH PROBLEMS — see above.\n");
  process.exit(1);
}

/* Warn, don't fail: a build is still useful for local testing. */
const cfg = fs.readFileSync(path.join(SRC, SHARED_DIR, "config.js"), "utf8");
const filled = k => new RegExp(k + '\\s*:\\s*"[^"]+"').test(cfg);

const blank = ks => ks.filter(k => !filled(k));

const noDb = blank(["supabaseUrl", "supabaseAnonKey"]);
if(noDb.length){
  console.log("  ! " + noDb.join(" and ") + " still empty in shared/config.js.");
  console.log("    Deployed like this, the two apps CANNOT see each other: each");
  console.log("    keeps its own private browser storage.\n");
}

// A pasted REST endpoint is the usual mistake: the client appends
// /rest/v1 itself, so this would double up and every call would 404.
const url = (cfg.match(/supabaseUrl\s*:\s*"([^"]*)"/) || [])[1] || "";
if(/\/rest\/v1\/?$/.test(url)){
  console.log("  ! supabaseUrl ends with /rest/v1 — remove it. Use just");
  console.log("    https://<project>.supabase.co\n");
  failed = true;
}

const noLinks = blank(["scannerUrl", "databaseUrl"]);
if(noLinks.length){
  console.log("  ! " + noLinks.join(" and ") + " still empty in shared/config.js.");
  console.log("    Normal on a first build — deploy both folders, then put their");
  console.log("    addresses in and rebuild so the apps can link to each other.\n");
}

if(failed){
  console.log("Build finished WITH PROBLEMS — see above.\n");
  process.exit(1);
}

console.log("Both apps built cleanly.\n");
console.log("UPLOAD THESE TWO FOLDERS — not scanner/, not database/,");
console.log("not the project root:\n");
console.log("   " + path.join(DIST, "scanner"));
console.log("   " + path.join(DIST, "database") + "\n");
console.log("Each goes to its OWN address. The source folders will not work");
console.log("if uploaded directly: their pages point at ../shared/, which only");
console.log("resolves here. The build flattens that away.\n");
