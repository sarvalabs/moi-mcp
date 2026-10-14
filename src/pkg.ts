import { createRequire } from "node:module";

// Resolves to the package root from both src/ (tsx, vitest) and dist/ (built). Kept at this depth on purpose: a file in a
// subfolder would resolve ../package.json to the wrong place under tsx and vitest.
const require = createRequire(import.meta.url);
export const pkg = require("../package.json") as { name: string; version: string };
