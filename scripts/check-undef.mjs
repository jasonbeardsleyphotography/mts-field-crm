/* Catch a module constant that is USED but never DECLARED.
 *
 * This exists because of a real bug that shipped: an edit removed
 * `const DRAG_LIFT = 52;` while leaving eight references to it. Rollup does
 * not error on an undeclared identifier — it assumes a global — so the build
 * passed, and the only symptom was that dragging a pin threw a ReferenceError
 * inside a touch handler and silently did nothing.
 *
 * Deliberately narrow: only SCREAMING_CASE names, which in this codebase are
 * always module-level constants or imports. Narrow enough to have no false
 * positives, which is the only way a check like this survives.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src", "netlify"];
const NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;   // needs an underscore: MAX_Z, DRAG_LIFT

// Screaming-case names that really are ambient.
const GLOBALS = new Set(["NaN", "URL_", "DOM_KEY_LOCATION", "XMLHttpRequest"]);

const files = [];
const walk = (dir) => {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|jsx|mjs)$/.test(e)) files.push(p);
  }
};
ROOTS.forEach(walk);

// Strip comments and string/template literals so text content can't look like code.
const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
  .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, "``")
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/'(?:\\.|[^'\\])*'/g, "''");

let bad = 0;
for (const file of files) {
  const code = strip(readFileSync(file, "utf8"));

  const declared = new Set(GLOBALS);
  // const/let/var/function/class declarations, including destructured ones.
  for (const m of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const n = part.split(":").pop().split("=")[0].trim().replace(/^\.\.\./, "");
      if (n) declared.add(n);
    }
  }
  // Import bindings.
  for (const m of code.matchAll(/import\s+([\s\S]*?)\s+from\s/g)) {
    for (const part of m[1].replace(/[{}]/g, " ").split(",")) {
      const n = part.split(/\s+as\s+/).pop().trim();
      if (n && n !== "*") declared.add(n);
    }
  }
  // Object keys and property access are not references to a binding.
  const refs = code
    .replace(/\.\s*[A-Za-z_$][\w$]*/g, " ")       // obj.CONST
    .replace(/\b[A-Z][A-Z0-9_]*\s*:/g, " ");      // { CONST: ... }

  for (const m of refs.matchAll(NAME)) {
    if (declared.has(m[0])) continue;
    console.error(`${file}: '${m[0]}' is used but never declared or imported`);
    bad++;
  }
}

if (bad) {
  console.error(`\n${bad} undeclared constant reference${bad === 1 ? "" : "s"}. Build stopped.`);
  process.exit(1);
}
