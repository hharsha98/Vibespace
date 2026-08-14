#!/usr/bin/env node
// Phase 11b (PARITY #52): builds the self-contained, relocatable server
// bundle that `apps/desktop/src-tauri/tauri.conf.json`'s `bundle.resources`
// ships inside the packaged app (DMG/NSIS/MSI/DEB/RPM/AppImage) — the fix
// for "the installer only works on the machine it was built on" (see
// docs/DESKTOP.md's "Why `tsx`, not the compiled server" for the original
// Phase 11a problem this solves). Run by `apps/desktop/package.json`'s
// `package:mac`/`package:win`/`package:linux` scripts, BEFORE `tauri build`
// — Tauri only copies resources that already exist on disk at bundle time,
// it doesn't generate them.
//
// # The bug this works around, and why the fix lives HERE, not in
// # packages/shared/package.json
//
// `apps/server/package.json`'s "start" script (`node dist/index.js`) is
// broken standalone: `packages/shared`'s `package.json` `main` field points
// at its TypeScript SOURCE (`./src/index.ts`), which only resolves when
// something in the chain transpiles on the fly (`tsx`, Vite, Vitest all do;
// plain `node` does not) — see main.rs's top doc comment for the full
// history. The obvious-looking fix — changing `packages/shared/package.json`
// itself to point `main` at `./dist/index.js` — was deliberately NOT done:
// every package in the workspace resolves `@vibedeck/shared` through that
// same field, including `pnpm dev`'s `tsx watch`, which relies on `dist/`
// NOT being required to exist for live-editing to work. Changing it
// repo-wide risks breaking the "no build step needed between edits" dev
// workflow for a fix only the PACKAGED build needs. So instead, this script
// patches the field only on a throwaway DEPLOYED COPY of the shared
// package, produced by `pnpm deploy` below, never the real one.
//
// # The hardlink trap (found by hand while building this phase)
//
// The naive version of that idea is dangerous: `pnpm deploy`'s target
// directory can contain files that are HARDLINKS into pnpm's
// content-addressable store, not independent copies — confirmed by hand:
// after a `pnpm deploy --legacy` locally, `stat -f "dev=%d inode=%i
// links=%l"` on the deployed copy's `@vibedeck/shared/package.json` showed
// the SAME device+inode as the real `packages/shared/package.json`, with a
// link count of 2. A plain `fs.writeFileSync` on that path (which opens the
// existing inode and truncates it) would have silently rewritten the REAL
// monorepo source file through the shared inode — which is exactly what
// happened once, while developing this script, before this comment and the
// unlink-before-write fix below existed. `patchSharedPackageJson` therefore
// ALWAYS unlinks the file before writing a fresh one, unconditionally —
// guaranteed to produce an independent inode regardless of whether pnpm
// happened to hardlink, symlink, or truly copy it this time.
//
// # The symlink trap (found by hand testing the actual packaged .app)
//
// `pnpm deploy`'s DEFAULT output — even the "self-contained" `--legacy`
// target — is NOT symlink-free: `node_modules/fastify`,
// `node_modules/@vibedeck/shared`, `node_modules/better-sqlite3`, etc. are
// all symlinks into a `node_modules/.pnpm/<name>@<version>/node_modules/
// <name>` virtual store that DOES contain real files. That's fine for
// running the bundle directly — but Tauri's own resource-bundling step
// (`tauri build` copying `bundle.resources` into the `.app`) was
// confirmed, by hand, to NOT preserve those top-level symlinks: the built
// `.app`'s `Resources/resources/server-bundle/node_modules/` ends up with
// `.pnpm/` (the real content) but WITHOUT `fastify`, `@vibedeck/shared`,
// or any other top-level package symlink — so the packaged server
// immediately fails with `ERR_MODULE_NOT_FOUND: Cannot find package
// 'fastify'` the moment it starts. Caught by actually launching a
// relocated copy of the built .app and watching it fail, not assumed.
//
// The real fix: `pnpm deploy --config.node-linker=hoisted` (below) asks
// pnpm to lay out `node_modules` the classic npm way — every package, ALL
// its transitive dependencies included, as a real directory directly
// under `node_modules/`, no virtual store, no per-package symlink maze.
// Verified by hand: this dropped a symlink count of "every single
// top-level package" down to 7 harmless `node_modules/.bin/*` shims
// (unused — this bundle only ever runs `node dist/index.js` directly,
// never anything under `.bin/`), while ALSO landing on a smaller total
// size (118MB) than a first attempt at fixing this by hand-writing a
// naive recursive symlink-dereferencer (527MB) — hoisted mode's own
// deduplication is simply better at this than a caller manually
// re-copying full dependency closures. `flattenNodeModules` still runs
// afterward as a cheap, verified-necessary safety net for exactly those
// remaining `.bin` symlinks (and anything pnpm's hoisting genuinely
// couldn't hoist, e.g. two different major versions of the same package)
// — see its own comment for why a hand-rolled walk was needed there
// instead of trusting `cpSync`'s `dereference` option.
//
// # What ends up in the bundle
//
// `apps/desktop/src-tauri/resources/`:
//   - `server-bundle/dist/index.js` + friends — apps/server's own `tsc`
//     build output, run directly by `node` (main.rs's `ServerSource::Bundled`).
//   - `server-bundle/node_modules/` — apps/server's PRODUCTION dependencies,
//     dereferenced by `pnpm deploy` (this is what makes `better-sqlite3`'s
//     and `node-pty`'s native `.node` binaries — built for THIS CI runner's
//     OS/arch — actually present and loadable from a relocated copy,
//     instead of symlinks into a pnpm store that won't exist on whatever
//     machine installs the app).
//   - `web/` — apps/web's built static assets (`apps/web/dist`), served by
//     the bundled server via `VIBEDECK_STATIC_DIR`.
//
// Real cost, stated plainly: this adds roughly 100-150MB to the installer
// (mostly `node-pty`, which ships prebuilt binaries for every platform
// inside one package regardless of host — see docs/DESKTOP.md). That's the
// honest price of "actually works when you move it," not an oversight.

import { execSync } from "node:child_process";
// Explicit import (not the bare global) — same convention
// scripts/fix-native-perms.mjs already established, since this repo's
// eslint config doesn't enable Node's global environment.
import console from "node:console";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  cpSync,
  renameSync,
  lstatSync,
  readdirSync,
  realpathSync,
  copyFileSync,
  chmodSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = join(SCRIPT_DIR, "..");
const REPO_ROOT = join(DESKTOP_DIR, "../..");
const RESOURCES_DIR = join(DESKTOP_DIR, "src-tauri/resources");
const SERVER_BUNDLE_DIR = join(RESOURCES_DIR, "server-bundle");
const WEB_RESOURCE_DIR = join(RESOURCES_DIR, "web");

function run(cmd, cwd) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

function freshDir(dir) {
  // Always start from nothing — a stale bundle from a previous run (a
  // different version, a half-finished deploy) must never silently survive
  // into a new package. `rmSync`'s `recursive`+`force` is the Node API
  // equivalent of `rm -rf`; safe here because `dir` is always one of the
  // two generated paths above, never anything outside this script's own
  // `resources/` output.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

/**
 * Rewrites the deployed copy's `@vibedeck/shared/package.json` to resolve
 * through its own already-built `dist/` instead of the TypeScript `src/`
 * the live monorepo's copy points at (see this file's top comment). Reads
 * PLUS unlinks-then-writes, deliberately never a plain overwrite — see
 * "The hardlink trap" above for exactly why that distinction matters.
 */
function patchSharedPackageJson(deployDir) {
  const pkgPath = join(deployDir, "node_modules/@vibedeck/shared/package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(
      `Expected a deployed @vibedeck/shared at ${pkgPath} — pnpm deploy's output shape may have ` +
        `changed. Refusing to guess; fix this script's assumptions before packaging."`
    );
  }
  const distEntry = join(deployDir, "node_modules/@vibedeck/shared/dist/index.js");
  if (!existsSync(distEntry)) {
    throw new Error(
      `${distEntry} doesn't exist — packages/shared must be built (\`pnpm --filter @vibedeck/shared build\`) ` +
        "before deploying, or the patched package.json below would point at nothing."
    );
  }

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.main = "./dist/index.js";
  pkg.types = "./dist/index.d.ts";

  // Unlink first — see "The hardlink trap" above. This guarantees a fresh
  // inode no matter what pnpm did internally, so this write can NEVER reach
  // back into the real packages/shared/package.json through a shared link.
  rmSync(pkgPath, { force: true });
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`patched ${pkgPath} to resolve via dist/ (independent copy, verified unlinked first)`);
}

/**
 * Recursively copies `src` to `dest`, resolving EVERY symlink encountered
 * (at any depth) to its real target's actual content — the destination
 * tree contains zero symlinks anywhere, guaranteed.
 *
 * NOT implemented with `fs.cpSync(..., { dereference: true })`, even
 * though that option exists and looks like exactly this. Confirmed by
 * hand (a minimal repro, isolated from this whole bundle) that
 * `cpSync`'s `dereference` does NOT dereference symlinks encountered
 * while walking a directory recursively — only a symlink passed directly
 * as the top-level `src` argument itself. A symlink one level below `src`
 * (e.g. `node_modules/fastify -> .pnpm/fastify@.../node_modules/fastify`,
 * exactly the shape pnpm produces) is copied AS a symlink regardless of
 * `dereference: true`. This was the actual root cause of "The symlink
 * trap" above surviving a first attempt at this fix that used plain
 * `cpSync` — caught by re-inspecting the packaged .app a second time
 * after that first fix, not assumed to work from the option's name alone.
 */
function dereferenceCopy(src, dest) {
  const st = lstatSync(src);
  if (st.isSymbolicLink()) {
    dereferenceCopy(realpathSync(src), dest);
    return;
  }
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      dereferenceCopy(join(src, entry), join(dest, entry));
    }
    return;
  }
  copyFileSync(src, dest);
  // `copyFileSync` creates the destination with default permissions and
  // drops the source's mode, which silently breaks every executable in the
  // tree. That is not theoretical: node-pty ships a `spawn-helper` binary
  // that it exec's to start a pty, and a non-executable copy of it makes
  // EVERY terminal in the packaged app fail with "posix_spawnp failed" —
  // the app launches, serves its API, and cannot open a single shell. It
  // was found exactly that way, by spawning a session against a relocated
  // build rather than by trusting that the copy looked complete.
  chmodSync(dest, st.mode);
}

/**
 * Replaces `<deployDir>/node_modules` with a fully dereferenced copy of
 * itself via `dereferenceCopy` above — no symlinks anywhere in the tree
 * afterward. See "The symlink trap" above for why this has to happen:
 * Tauri's resource bundler was confirmed (by hand, launching a relocated
 * built .app) to silently drop pnpm's top-level package symlinks while
 * still copying their real `.pnpm/` targets, which breaks every
 * `import "some-package"` in the shipped server.
 */
function flattenNodeModules(deployDir) {
  const nodeModulesDir = join(deployDir, "node_modules");
  const flatDir = join(deployDir, "node_modules.flat");
  rmSync(flatDir, { recursive: true, force: true });
  dereferenceCopy(nodeModulesDir, flatDir);
  rmSync(nodeModulesDir, { recursive: true, force: true });
  renameSync(flatDir, nodeModulesDir);
  console.log(`flattened ${nodeModulesDir} (dereferenced every symlink — verified no top-level package symlinks remain below)`);
}

/**
 * Restores `+x` on every `spawn-helper` binary node-pty ships.
 *
 * node-pty exec's this helper to start a pty. `pnpm deploy` emits it
 * non-executable (`-rw-r--r--`, against `-rwxr-xr-x` in the repo's real
 * `node_modules`), so a faithful mode-preserving copy preserves the broken
 * mode. The symptom is nasty precisely because everything else works: the
 * packaged app starts, serves its entire HTTP API, renders the UI — and
 * every single terminal fails with "posix_spawnp failed", which is the one
 * thing this product exists to do.
 *
 * Deliberately targeted rather than a blanket `chmod -R +x`: making every
 * file in a 120MB bundle executable to fix two of them would be a much
 * larger change than the problem warrants. If another bundled dependency
 * ever needs its own executable, add it here explicitly, with the same
 * kind of note about how the breakage shows up.
 */
function restoreSpawnHelperPermissions(deployDir) {
  const ptyPrebuilds = join(deployDir, "node_modules", "node-pty", "prebuilds");
  if (!existsSync(ptyPrebuilds)) return;

  let fixed = 0;
  for (const platform of readdirSync(ptyPrebuilds)) {
    const helper = join(ptyPrebuilds, platform, "spawn-helper");
    if (!existsSync(helper)) continue;
    // 0o755 — owner writes, everyone reads and executes. Matches what the
    // package ships with in a normal npm/pnpm install.
    chmodSync(helper, 0o755);
    fixed += 1;
  }
  console.log(`restored +x on ${fixed} node-pty spawn-helper binaries (pnpm deploy drops it; every pty fails without it)`);
}

console.log("--- Phase 11b: building the relocatable server bundle ---");

// 1. Build packages/shared and apps/server's own compiled output. Neither
//    is part of the existing `apps/desktop` build chain (which only builds
//    apps/web) — both are needed here specifically so `pnpm deploy` below
//    has real `dist/` output to carry into the bundle.
run("pnpm --filter @vibedeck/shared build", REPO_ROOT);
run("pnpm --filter @vibedeck/server build", REPO_ROOT);

// 2. Fresh output directories.
freshDir(SERVER_BUNDLE_DIR);
freshDir(WEB_RESOURCE_DIR);

// 3. `pnpm deploy` — NOT a plain copy — specifically because apps/server's
//    own `node_modules/@vibedeck/shared`, `node_modules/better-sqlite3`,
//    and `node_modules/node-pty` are pnpm-symlinked into a shared store
//    that plainly does not exist on whichever machine ends up installing
//    this app; `deploy` produces a self-contained tree instead (verified by
//    hand: its target directory resolves independently of the live repo —
//    see this file's top comment for the one place that independence
//    ALMOST broke down). `--legacy` avoids requiring
//    `inject-workspace-packages=true` workspace-wide just for this one
//    packaging step. `--prod` excludes devDependencies (tsx, vitest,
//    typescript, the test files' own type stubs) — this bundle only ever
//    runs the already-compiled `dist/`, it never needs a TypeScript
//    toolchain. `--config.node-linker=hoisted` is the actual fix for "The
//    symlink trap" below — it's what makes `deploy` lay out `node_modules`
//    as real, top-level directories (the classic npm shape) instead of
//    pnpm's default per-package virtual-store symlink maze, which is what
//    was actually breaking the packaged app (see that comment for the full
//    story, including why a first attempt at fixing this with a hand-
//    rolled recursive symlink copier was worse — bigger AND still wrong).
run(
  `pnpm --filter @vibedeck/server deploy --prod --legacy --config.node-linker=hoisted "${SERVER_BUNDLE_DIR}"`,
  REPO_ROOT
);

// 4. Dereference the handful of symlinks hoisted mode still leaves behind
//    (verified by hand: 7, all harmless `node_modules/.bin/*` shims this
//    bundle never invokes — it only ever runs `node dist/index.js`
//    directly) — cheap insurance against Tauri's resource copier dropping
//    ANY symlink, not just the ones this phase happened to hit by hand.
//    Must happen BEFORE `tauri build` ever touches this directory.
flattenNodeModules(SERVER_BUNDLE_DIR);

// 4b. Restore the executable bit on node-pty's `spawn-helper`.
//
//     `pnpm deploy` writes this file WITHOUT +x (verified: `-rw-r--r--` in
//     the deployed tree, `-rwxr-xr-x` in the repo's real node_modules), and
//     preserving modes faithfully through the copy therefore preserves the
//     wrong one. node-pty exec's this binary to start every pty, so without
//     +x the packaged app launches, serves its whole API, and then fails
//     EVERY terminal with "posix_spawnp failed" — the product's core
//     feature, broken in a way nothing but actually spawning a session
//     against a packaged build will reveal. That is how it was found.
restoreSpawnHelperPermissions(SERVER_BUNDLE_DIR);

// 5. The one real patch this whole script exists for.
patchSharedPackageJson(SERVER_BUNDLE_DIR);

// 6. Copy the built web app in too. `cpSync` with `recursive: true` follows
//    symlinks by default (Node's default `dereference` for cpSync is
//    false, but apps/web/dist is a plain build output directory with no
//    symlinks in it in the first place, so this is a plain deep copy).
const webDist = join(REPO_ROOT, "apps/web/dist");
if (!existsSync(webDist)) {
  throw new Error(
    `${webDist} doesn't exist — run \`pnpm --filter @vibedeck/web build\` (or this package's own ` +
      "\"build\" script) before build-server-resources.mjs."
  );
}
cpSync(webDist, WEB_RESOURCE_DIR, { recursive: true });

// 7. Put the tracked `.gitkeep` markers back.
//
//    Steps 3 and 6 above delete and recreate both resource directories,
//    which takes these two files with them — and they are the only tracked
//    contents of either directory (see apps/desktop/.gitignore). Without
//    them a `git status` after any packaging run shows them deleted, and a
//    fresh clone has neither directory at all, which Tauri's build script
//    rejects because `bundle.resources` names paths that must exist even
//    for a plain `cargo check`. Rewriting them here keeps that invariant
//    true by construction instead of relying on nobody running the
//    packaging step.
for (const dir of [SERVER_BUNDLE_DIR, WEB_RESOURCE_DIR]) {
  writeFileSync(join(dir, ".gitkeep"), "");
}

console.log("--- server bundle ready ---");
console.log(`  ${SERVER_BUNDLE_DIR}`);
console.log(`  ${WEB_RESOURCE_DIR}`);
