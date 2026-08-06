import { readFileSync, writeFileSync } from "node:fs";

const path = "/app/src/index.ts";
const source = readFileSync(path, "utf8");
const before =
  '  return principal ?? (!CORE_SIGNING_SECRET || ALLOW_UNSIGNED_TEST_IDENTITY ? cookie(req, "admin") : null);';
const after = `  return (
    principal ??
    (!CORE_SIGNING_SECRET || ALLOW_UNSIGNED_TEST_IDENTITY
      ? cookie(req, "admin") ?? (ALLOW_UNSIGNED_TEST_IDENTITY ? cookie(req, "webuiuser") : null)
      : null)
  );`;

if (!source.includes(before)) throw new Error("admin source shape changed");
writeFileSync(path, source.replace(before, after));
