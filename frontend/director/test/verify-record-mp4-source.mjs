#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
assert.match(app, /const name = `cozyclay-\$\{slate\}\.mp4`/);
assert.doesNotMatch(app, /const name = `cozyclay-\$\{slate\}\.webm`/);
console.log("PASS Record downloads a .mp4 file");
