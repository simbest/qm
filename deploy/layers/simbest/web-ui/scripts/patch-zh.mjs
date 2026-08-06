#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";

const distDir = process.argv[2] ?? "./dist-web";
const dictPath = process.argv[3] ?? "./zh-CN.json";

const rawDict = JSON.parse(readFileSync(dictPath, "utf8"));

const SHORT_THRESHOLD = 14;

const entries = Object.entries(rawDict)
  .filter(([en]) => en.trim().length > 0)
  .sort((a, b) => b[0].length - a[0].length);

let totalPatched = 0;
const touchedFiles = [];

function patchContent(content, fileName) {
  let patched = content;
  let fileChanges = 0;

  for (const [en, zh] of entries) {
    if (!en || !zh || en === zh) continue;
    if (en.length < SHORT_THRESHOLD) {
      const patterns = [
        { open: '"', close: '"' },
        { open: "'", close: "'" },
        { open: "`", close: "`" },
        { open: ">", close: "<" },
      ];
      for (const { open, close } of patterns) {
        const target = `${open}${en}${close}`;
        const replacement = `${open}${zh}${close}`;
        if (patched.includes(target)) {
          patched = patched.split(target).join(replacement);
          fileChanges++;
        }
      }
    } else {
      if (patched.includes(en)) {
        patched = patched.split(en).join(zh);
        fileChanges++;
      }
    }
  }

  if (fileChanges > 0) {
    writeFileSync(fileName, patched, "utf8");
    touchedFiles.push(basename(fileName));
    totalPatched += fileChanges;
  }
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full);
      continue;
    }
    const ext = extname(name);
    if (ext === ".js" || ext === ".html" || ext === ".css") {
      patchContent(readFileSync(full, "utf8"), full);
    }
  }
}

walk(distDir);

import { createHash } from "node:crypto";
const { renameSync, readFileSync: readSync } = await import("node:fs");

const dictHash = createHash("md5").update(JSON.stringify(rawDict)).digest("hex").slice(0, 8);
const suffix = `.zh-${dictHash}.js`;

const assetsDir = join(distDir, "assets");
const renames = new Map();
for (const name of readdirSync(assetsDir)) {
  if (extname(name) === ".js") {
    const oldStem = name.replace(/\.js$/, "");
    const newName = oldStem + suffix;
    renameSync(join(assetsDir, name), join(assetsDir, newName));
    renames.set(oldStem + ".js", newName);
    renames.set(oldStem, oldStem + suffix.slice(0, -3));
  }
}

for (const name of readdirSync(assetsDir)) {
  const full = join(assetsDir, name);
  if (extname(full) !== ".js") continue;
  let content = readFileSync(full, "utf8");
  let changed = false;
  for (const [oldName, newName] of renames) {
    if (content.includes(oldName)) {
      content = content.split(oldName).join(newName);
      changed = true;
    }
  }
  if (changed) writeFileSync(full, content, "utf8");
}

let html = readFileSync(join(distDir, "index.html"), "utf8");
html = html.replace(/(\/assets\/[^"']+)\.js/g, `$1${suffix}`);
writeFileSync(join(distDir, "index.html"), html, "utf8");

console.log(
  `[patch-zh] ${entries.length} entries scanned, ${totalPatched} replacements in ${touchedFiles.length} files` +
    (touchedFiles.length > 0 ? `: ${touchedFiles.join(", ")}` : "") +
    ` + JS renamed with dict hash ${dictHash}`,
);
