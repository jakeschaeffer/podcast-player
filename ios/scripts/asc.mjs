#!/usr/bin/env node
// App Store Connect setup for Snip, through the ASC REST API (no Xcode account needed). Idempotent:
//   node ios/scripts/asc.mjs ensure-profile [bundle id]   # register the bundle id and mint + install an App Store profile
//   node ios/scripts/asc.mjs app              # print the app record's id, if it exists
// Your team's values come from scripts/local.env (gitignored; copy local.env.example): the key id and issuer of an
// App Store Connect API key with the App Manager role, whose .p8 sits at ~/.appstoreconnect/private_keys/AuthKey_<id>.p8.
import { createPrivateKey, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// KEY=value lines of scripts/local.env, for a run by hand; testflight.sh exports the same values first.
const localEnv = join(dirname(fileURLToPath(import.meta.url)), "local.env");
const local = Object.fromEntries(
  (existsSync(localEnv) ? readFileSync(localEnv, "utf8") : "")
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]),
);
const need = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`${name} is not set: fill in ios/scripts/local.env (see local.env.example)`);
  return value;
};
const BUNDLE_ID = need("SNIP_BUNDLE_ID", local.ORG_IDENTIFIER && `${local.ORG_IDENTIFIER}.Snip`);
const keyId = need("SNIP_ASC_KEY_ID", local.ASC_KEY_ID);
const issuer = need("SNIP_ASC_ISSUER", local.ASC_ISSUER);

function token() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "ES256", kid: keyId, typ: "JWT" })}.${b64({ iss: issuer, iat: now, exp: now + 15 * 60, aud: "appstoreconnect-v1" })}`;
  const key = createPrivateKey(readFileSync(join(homedir(), ".appstoreconnect/private_keys", `AuthKey_${keyId}.p8`)));
  return `${body}.${sign("sha256", Buffer.from(body), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

async function api(method, path, body) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json?.errors ?? json)}`);
  return json;
}

async function bundleId(identifier) {
  const found = await api("GET", `/v1/bundleIds?filter[identifier]=${identifier}&filter[platform]=IOS`);
  const exact = found.data.find((b) => b.attributes.identifier === identifier);
  if (exact) return exact.id;
  const name = identifier === BUNDLE_ID ? "Snip" : `Snip ${identifier.slice(BUNDLE_ID.length + 1)}`;
  const made = await api("POST", "/v1/bundleIds", { data: { type: "bundleIds", attributes: { identifier, name, platform: "IOS" } } });
  console.error(`registered bundle id ${identifier}`);
  return made.data.id;
}

/** `ensure-profile [bundle id]`: the app's App Store profile, or an extension's (`<bundle id>.LiveActivity`, `<bundle id>.Share`). */
async function ensureProfile() {
  const identifier = process.argv[3] ?? BUNDLE_ID;
  const PROFILE_NAME = `AS ${identifier}`;
  const bundle = await bundleId(identifier);
  const certs = await api("GET", "/v1/certificates?filter[certificateType]=DISTRIBUTION,IOS_DISTRIBUTION&limit=50");
  const cert = certs.data.filter((c) => new Date(c.attributes.expirationDate) > new Date()).sort((a, b) => b.attributes.expirationDate.localeCompare(a.attributes.expirationDate))[0];
  if (!cert) throw new Error("no valid Apple Distribution certificate on the account");
  const existing = await api("GET", `/v1/profiles?filter[name]=${encodeURIComponent(PROFILE_NAME)}&filter[profileState]=ACTIVE`);
  let profile = existing.data.find((p) => p.attributes.name === PROFILE_NAME);
  if (!profile) {
    profile = (await api("POST", "/v1/profiles", {
      data: {
        type: "profiles",
        attributes: { name: PROFILE_NAME, profileType: "IOS_APP_STORE" },
        relationships: { bundleId: { data: { type: "bundleIds", id: bundle } }, certificates: { data: [{ type: "certificates", id: cert.id }] } },
      },
    })).data;
    console.error(`created profile "${PROFILE_NAME}"`);
  }
  const dir = join(homedir(), "Library/Developer/Xcode/UserData/Provisioning Profiles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${profile.attributes.uuid}.mobileprovision`), Buffer.from(profile.attributes.profileContent, "base64"));
  console.log(PROFILE_NAME);
}

async function app() {
  const found = await api("GET", `/v1/apps?filter[bundleId]=${BUNDLE_ID}`);
  if (!found.data.length) throw new Error(`no App Store Connect app for ${BUNDLE_ID}: create it under Apps → + → New App`);
  console.log(found.data[0].id);
}

// An internal TestFlight group that gets every build, with the account holder in it. Internal testing needs no
// App Review; each new upload reaches the phone once processing finishes.
async function ensureBetaGroup() {
  const appId = (await api("GET", `/v1/apps?filter[bundleId]=${BUNDLE_ID}`)).data[0]?.id;
  if (!appId) throw new Error(`no App Store Connect app for ${BUNDLE_ID}`);
  const groups = await api("GET", `/v1/apps/${appId}/betaGroups`);
  let group = groups.data.find((g) => g.attributes.isInternalGroup && g.attributes.name === "Owner");
  if (!group) {
    group = (await api("POST", "/v1/betaGroups", {
      data: { type: "betaGroups", attributes: { name: "Owner", isInternalGroup: true, hasAccessToAllBuilds: true }, relationships: { app: { data: { type: "apps", id: appId } } } },
    })).data;
    console.error('created internal group "Owner"');
  }
  const holder = (await api("GET", "/v1/users?limit=50")).data.find((u) => u.attributes.roles.includes("ACCOUNT_HOLDER"));
  const testers = await api("GET", `/v1/betaGroups/${group.id}/betaTesters?limit=200`);
  if (holder && !testers.data.some((t) => t.attributes.email === holder.attributes.username)) {
    await api("POST", "/v1/betaTesters", {
      data: {
        type: "betaTesters",
        attributes: { email: holder.attributes.username, firstName: holder.attributes.firstName, lastName: holder.attributes.lastName },
        relationships: { betaGroups: { data: [{ type: "betaGroups", id: group.id }] } },
      },
    });
    console.error(`added ${holder.attributes.username} to "Owner"`);
  }
  console.log(group.id);
}

const commands = { "ensure-profile": ensureProfile, app, "ensure-beta-group": ensureBetaGroup };
const run = commands[process.argv[2]];
if (!run) throw new Error(`usage: asc.mjs ${Object.keys(commands).join(" | ")}`);
await run();
