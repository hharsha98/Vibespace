#!/usr/bin/env node
/**
 * Copies the OSC 133 shell-integration script into `dist/` after `tsc`.
 *
 * `tsc` only emits from `.ts` sources, so `vibespace-integration.zsh` —
 * which the pty layer reads at runtime to inject shell integration (see
 * `src/pty/shell-integration/`) — has to be carried across separately.
 *
 * This used to be `mkdir -p ... && cp ...` inline in the build script,
 * which works on macOS and Linux and fails on Windows with "The syntax of
 * the command is incorrect." That is not hypothetical: it broke the
 * Windows leg of the very first release build, at a step that had never
 * run on Windows before. Node's own fs is the portable way to do this and
 * needs no extra dependency.
 *
 * Windows never uses the zsh integration itself, but the build must still
 * succeed there — the desktop bundler runs this exact script on every
 * platform before packaging.
 */
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");

const relativePath = join("pty", "shell-integration", "vibespace-integration.zsh");
const source = join(packageRoot, "src", relativePath);
const destination = join(packageRoot, "dist", relativePath);

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
