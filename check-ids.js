/* ============================================================
   check-ids.js — run with:  node check-ids.js
   ------------------------------------------------------------
   Every element id a page script reaches for must exist in that
   page's HTML, and every id in the HTML should be used. A missing
   one is a TypeError on a real phone and nothing here, because
   the stubbed DOM in selftest.js invents elements on demand.
   ============================================================ */

const fs = require("fs");
const path = require("path");

const PAGES = [
  { html: path.join("scanner", "index.html"),
    js:  [path.join("scanner", "scanner.js")] },
  { html: path.join("database", "index.html"),
    js:  [path.join("database", "database.js")] }
];

let bad = 0;

for(const page of PAGES){
  const html = fs.readFileSync(path.join(__dirname, page.html), "utf8");
  const js = page.js.map(f => fs.readFileSync(path.join(__dirname, f), "utf8")).join("\n");

  const used = [...new Set(
    [...js.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map(m => m[1])
      .concat([...js.matchAll(/getElementById\("([A-Za-z0-9_-]+)"\)/g)].map(m => m[1]))
  )];
  const declared = [...new Set(
    [...html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map(m => m[1])
  )];

  const missing = used.filter(id => !declared.includes(id));
  // ids the HTML declares but no script touches — usually harmless
  // (styling hooks), listed only so a rename does not leave litter
  const unused = declared.filter(id => !used.includes(id) && !html.includes('for="' + id + '"'));

  console.log("\n" + page.html);
  if(missing.length){
    bad++;
    console.log("  MISSING in HTML: " + missing.join(", "));
  } else {
    console.log("  all " + used.length + " referenced ids exist");
  }
  if(unused.length) console.log("  declared but unused: " + unused.join(", "));
}

console.log(bad ? "\n" + bad + " page(s) reference ids that do not exist\n"
                : "\nAll id references resolve.\n");
process.exit(bad ? 1 : 0);
