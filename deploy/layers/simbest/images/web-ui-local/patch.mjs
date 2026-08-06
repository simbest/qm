import { readFileSync, writeFileSync } from "node:fs";

const path = "/app/server/index.ts";
const source = readFileSync(path, "utf8");
const importBefore =
  'import { verifyPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";';
const importAfter =
  'import { mintPortalIdentity, verifyPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";';
const handlerBefore = `  const raw = req.headers[PORTAL_IDENTITY_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  try {
    await portalTokenStore.run(token, () => routeRequest(req, res));`;
const handlerAfter = `  const raw = req.headers[PORTAL_IDENTITY_HEADER];
  const forwardedToken = Array.isArray(raw) ? raw[0] : raw;
  const identity = resolveIdentity(req);
  const token =
    forwardedToken ??
    (ALLOW_UNSIGNED_TEST_IDENTITY && PORTAL_IDENTITY_SECRET && identity
      ? mintPortalIdentity(
          {
            p: identity.user,
            ...(identity.name ? { n: identity.name } : {}),
            exp: Date.now() + 60_000,
          },
          PORTAL_IDENTITY_SECRET,
        )
      : undefined);
  try {
    await portalTokenStore.run(token, () => routeRequest(req, res));`;

if (!source.includes(importBefore) || !source.includes(handlerBefore)) throw new Error("web-ui source shape changed");
writeFileSync(path, source.replace(importBefore, importAfter).replace(handlerBefore, handlerAfter));
