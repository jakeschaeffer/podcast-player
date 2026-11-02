/** Re-point every recording at its preferred transcript under TEXT_PREFERRED_KINDS, and report the split. */
import { createContext } from "../app/context.js";
import { loadConfig } from "../lib/config.js";
import { applyTextPolicy } from "../services/textPolicy.js";

const ctx = createContext(loadConfig());
console.log(JSON.stringify({ preferred_kinds: [...ctx.config.textPreferredKinds], ...applyTextPolicy(ctx) }));
ctx.db.close();
