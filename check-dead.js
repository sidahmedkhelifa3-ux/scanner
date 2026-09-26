/* ============================================================
   check-dead.js — run with:  node check-dead.js
   ------------------------------------------------------------
   Finds things that are defined but never used: functions, config
   keys, CSS classes. None of these break the app on their own,
   but each one is either a leftover from a change that was not
   finished, or a feature that quietly stopped being wired up.
   ============================================================ */

const fs = require("fs");
const path = require("path");

const SRC = __dirname;
const JS = ["shared/common.js", "shared/store.js", "shared/config.js",
            "scanner/decoder.js", "scanner/ocr.js", "scanner/label-parser.js",
            "scanner/scanner.js", "database/database.js"];
const HTML = ["scanner/index.html", "database/index.html"];
const CSS = "shared/styles.css";

const read = f => fs.readFileSync(path.join(SRC, f), "utf8");
const strip = s => s
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

let issues = 0;
function note(kind, msg){ issues++; console.log("  " + kind + "  " + msg); }

/* ---------- functions never called ---------- */
console.log("\nFunctions defined but never called");
for(const f of JS){
  const raw = read(f), code = strip(raw);
  const defined = [...new Set(
    [...code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1])
  )];
  // everything that might call it: this file plus every other file
  const everywhere = JS.concat(HTML).map(read).join("\n");
  for(const name of defined){
    // Count EVERY mention, not just calls: a callback is handed over by
    // reference (addEventListener("click", foo)) and never written foo().
    const all = (everywhere.match(new RegExp("\\b" + name + "\\b", "g")) || []).length;
    const defs = (everywhere.match(new RegExp("function\\s+" + name + "\\b", "g")) || []).length;
    if(all - defs <= 0) note("DEAD FN ", f + " -> " + name + "()");
  }
}

/* ---------- config keys never read ---------- */
console.log("\nConfig keys never read");
const cfg = read("shared/config.js");
const keys = [...cfg.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:/gm)].map(m => m[1]);
const consumers = JS.filter(f => f !== "shared/config.js").map(read).join("\n");
for(const k of keys){
  if(!new RegExp("\\b" + k + "\\b").test(consumers)) note("UNUSED  ", "config." + k);
}

/* ---------- css classes never used ---------- */
console.log("\nCSS classes never used in markup or scripts");
const css = read(CSS);
const classes = [...new Set(
  [...css.matchAll(/\.([a-zA-Z][\w-]+)(?=[^{}]*\{)/g)].map(m => m[1])
)];
const markup = HTML.concat(JS).map(read).join("\n");
for(const c of classes){
  if(!new RegExp('["\'\\s.]' + c + '["\'\\s.,)]').test(markup)) note("UNUSED  ", "." + c);
}

console.log(issues ? "\n" + issues + " item(s) to look at\n"
                   : "\nNothing dead found.\n");
