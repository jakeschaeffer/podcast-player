/**
 * server/openapi.json is the committed API contract: the web client's types and the native app's client are built
 * from it, so a route change that is not reflected there fails here, in the same commit.
 * Regenerate with `pnpm --dir server openapi:update`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/http/app.js";
import { testContext } from "./helpers/context.js";

const CONTRACT = join(dirname(fileURLToPath(import.meta.url)), "..", "openapi.json");

describe("committed OpenAPI document", () => {
  it("matches what the routes declare", async () => {
    const app = await buildApp(testContext());
    await app.ready();
    const current = `${JSON.stringify(app.swagger(), null, 2)}\n`;
    await app.close();
    if (process.env.UPDATE_OPENAPI === "1") writeFileSync(CONTRACT, current);
    const committed = readFileSync(CONTRACT, "utf8");
    expect(committed, "server/openapi.json is stale: run `pnpm --dir server openapi:update` and commit it").toBe(current);
  });
});
