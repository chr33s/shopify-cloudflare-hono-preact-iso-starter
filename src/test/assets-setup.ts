/// <reference types="node" />
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

// The worker SSRs into ASSETS `/index.html`. `vp test` does not build `dist/client`.
export function setup() {
	if (existsSync("dist/client/index.html")) return;
	mkdirSync("dist/client", { recursive: true });
	copyFileSync("index.html", "dist/client/index.html");
}
