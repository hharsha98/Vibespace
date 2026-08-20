/**
 * REST endpoints for SSH connection profiles: full CRUD plus a one-click
 * Duplicate action (BridgeSpace v3.2.1 parity). Structured exactly like
 * `agents/routes.ts` — request validation + wiring only, all persistence in
 * `./store.ts` — since `AgentProfileStore`/`agents/routes.ts` is this
 * feature's closest existing analogue (per the task brief).
 *
 * One structural difference from `agents/routes.ts`, worth calling out:
 * profiles here are GLOBAL, not workspace-scoped (see
 * `packages/shared/src/protocol.ts`'s `SshProfile` doc comment for why), so
 * there is no `requireWorkspace`-style gate on any of these routes — every
 * request just operates on the one global set of profiles.
 *
 * Registered under `/api/ssh-profiles` (not `/api/ssh` or `/api/ssh/profiles`)
 * to read as a plain REST collection, matching the `/api/agent-profiles`
 * naming convention this codebase already uses for the analogous resource.
 */
import type { FastifyInstance } from "fastify";
import {
  SSH_PROFILE_FIELD_MAX_LENGTH,
  SSH_PROFILE_STARTUP_COMMAND_MAX_LENGTH,
} from "@vibedeck/shared";
import type { SshProfileStore, UpdateSshProfileOptions } from "./store.js";

export interface SshRoutesDeps {
  sshProfileStore: SshProfileStore;
}

/** Names the conflict, matching `agents/routes.ts`'s `duplicateNameError`
 * shape (`error` names exactly what collided) and `swarm/routes.ts`'s
 * claims-409 convention. */
function duplicateNameError(name: string) {
  return { error: `An SSH profile named "${name}" already exists` };
}

/** Validates a required non-empty string field, capped at
 * `SSH_PROFILE_FIELD_MAX_LENGTH`. Returns the trimmed value, or an error
 * string to send as a 400. */
function validateRequiredField(value: unknown, field: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, error: `"${field}" must be a non-empty string` };
  }
  if (value.length > SSH_PROFILE_FIELD_MAX_LENGTH) {
    return { ok: false, error: `"${field}" must be at most ${SSH_PROFILE_FIELD_MAX_LENGTH} characters` };
  }
  return { ok: true, value: value.trim() };
}

/** Validates an optional nullable string field (user/defaultDirectory):
 * `undefined` -> "not provided" (caller decides create-vs-patch default),
 * `null` -> explicitly cleared, a non-empty string -> the trimmed value.
 * An empty/whitespace-only string is treated the same as `null` — there's
 * no meaningful difference between "" and "not set" for these fields. */
function validateOptionalStringField(
  value: unknown,
  field: string
): { ok: true; value: string | null | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, error: `"${field}" must be a string or null` };
  }
  if (value.length > SSH_PROFILE_FIELD_MAX_LENGTH) {
    return { ok: false, error: `"${field}" must be at most ${SSH_PROFILE_FIELD_MAX_LENGTH} characters` };
  }
  const trimmed = value.trim();
  return { ok: true, value: trimmed.length === 0 ? null : trimmed };
}

/** Validates the optional nullable `startupCommand` field — same shape as
 * `validateOptionalStringField` but capped at the (much larger)
 * `SSH_PROFILE_STARTUP_COMMAND_MAX_LENGTH` instead, since it's a shell
 * command/script, not a short identifier. Deliberately NOT trimmed the way
 * the other string fields are: leading/trailing whitespace in a multi-line
 * shell script can be meaningful (or at least harmless either way), unlike
 * a name/host/directory. */
function validateStartupCommand(
  value: unknown
): { ok: true; value: string | null | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, error: '"startupCommand" must be a string or null' };
  }
  if (value.length > SSH_PROFILE_STARTUP_COMMAND_MAX_LENGTH) {
    return {
      ok: false,
      error: `"startupCommand" must be at most ${SSH_PROFILE_STARTUP_COMMAND_MAX_LENGTH} characters`,
    };
  }
  return { ok: true, value: value.length === 0 ? null : value };
}

/** Validates the optional nullable `port` field: must be an integer in the
 * valid TCP port range (1-65535), or null/undefined. */
function validatePort(value: unknown): { ok: true; value: number | null | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    return { ok: false, error: '"port" must be an integer between 1 and 65535, or null' };
  }
  return { ok: true, value };
}

export function registerSshRoutes(app: FastifyInstance, deps: SshRoutesDeps): void {
  const { sshProfileStore } = deps;

  app.get("/api/ssh-profiles", async () => {
    return { profiles: sshProfileStore.list() };
  });

  app.get("/api/ssh-profiles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const profile = sshProfileStore.get(id);
    if (!profile) {
      return reply.status(404).send({ error: `No SSH profile with id "${id}"` });
    }
    return profile;
  });

  app.post("/api/ssh-profiles", async (request, reply) => {
    const body = (request.body ?? {}) as {
      name?: unknown;
      host?: unknown;
      user?: unknown;
      port?: unknown;
      defaultDirectory?: unknown;
      startupCommand?: unknown;
    };

    const name = validateRequiredField(body.name, "name");
    if (!name.ok) return reply.status(400).send({ error: name.error });

    const host = validateRequiredField(body.host, "host");
    if (!host.ok) return reply.status(400).send({ error: host.error });

    const user = validateOptionalStringField(body.user, "user");
    if (!user.ok) return reply.status(400).send({ error: user.error });

    const port = validatePort(body.port);
    if (!port.ok) return reply.status(400).send({ error: port.error });

    const defaultDirectory = validateOptionalStringField(body.defaultDirectory, "defaultDirectory");
    if (!defaultDirectory.ok) return reply.status(400).send({ error: defaultDirectory.error });

    const startupCommand = validateStartupCommand(body.startupCommand);
    if (!startupCommand.ok) return reply.status(400).send({ error: startupCommand.error });

    const result = sshProfileStore.create({
      name: name.value,
      host: host.value,
      user: user.value ?? null,
      port: port.value ?? null,
      defaultDirectory: defaultDirectory.value ?? null,
      startupCommand: startupCommand.value ?? null,
    });
    if (!result.ok) {
      // The only failure create() can report is a duplicate name — see
      // ./store.ts's top comment for why this is a UNIQUE-constraint
      // rejection, not a pre-check, and therefore race-safe.
      return reply.status(409).send(duplicateNameError(name.value));
    }
    return reply.status(201).send(result.profile);
  });

  app.patch("/api/ssh-profiles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = sshProfileStore.get(id);
    if (!existing) {
      return reply.status(404).send({ error: `No SSH profile with id "${id}"` });
    }

    const body = (request.body ?? {}) as {
      name?: unknown;
      host?: unknown;
      user?: unknown;
      port?: unknown;
      defaultDirectory?: unknown;
      startupCommand?: unknown;
    };
    const patch: UpdateSshProfileOptions = {};

    if ("name" in body) {
      const name = validateRequiredField(body.name, "name");
      if (!name.ok) return reply.status(400).send({ error: name.error });
      patch.name = name.value;
    }
    if ("host" in body) {
      const host = validateRequiredField(body.host, "host");
      if (!host.ok) return reply.status(400).send({ error: host.error });
      patch.host = host.value;
    }
    if ("user" in body) {
      const user = validateOptionalStringField(body.user, "user");
      if (!user.ok) return reply.status(400).send({ error: user.error });
      patch.user = user.value ?? null;
    }
    if ("port" in body) {
      const port = validatePort(body.port);
      if (!port.ok) return reply.status(400).send({ error: port.error });
      patch.port = port.value ?? null;
    }
    if ("defaultDirectory" in body) {
      const defaultDirectory = validateOptionalStringField(body.defaultDirectory, "defaultDirectory");
      if (!defaultDirectory.ok) return reply.status(400).send({ error: defaultDirectory.error });
      patch.defaultDirectory = defaultDirectory.value ?? null;
    }
    if ("startupCommand" in body) {
      const startupCommand = validateStartupCommand(body.startupCommand);
      if (!startupCommand.ok) return reply.status(400).send({ error: startupCommand.error });
      patch.startupCommand = startupCommand.value ?? null;
    }

    const result = sshProfileStore.update(id, patch);
    if (!result.ok) {
      if (result.reason === "not-found") {
        // Existence was already confirmed above; better-sqlite3 is
        // synchronous, so nothing could have deleted it in between — this
        // branch is unreachable in practice but kept because the store's
        // return type carries it honestly (same note as agents/routes.ts).
        return reply.status(404).send({ error: `No SSH profile with id "${id}"` });
      }
      return reply.status(409).send(duplicateNameError(patch.name ?? existing.name));
    }
    return result.profile;
  });

  app.delete("/api/ssh-profiles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!sshProfileStore.remove(id)) {
      return reply.status(404).send({ error: `No SSH profile with id "${id}"` });
    }
    return reply.status(204).send();
  });

  // One-click Duplicate (BridgeSpace v3.2.1 parity) — see store.ts's
  // `duplicate()` for how a free "X copy"/"X copy N" name is picked.
  app.post("/api/ssh-profiles/:id/duplicate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = sshProfileStore.duplicate(id);
    if (!result.ok) {
      if (result.reason === "not-found") {
        return reply.status(404).send({ error: `No SSH profile with id "${id}"` });
      }
      // Practically unreachable (duplicate() itself retries on a name
      // collision — see its own comment) but kept honest for the same
      // reason the PATCH handler's not-found branch above is.
      return reply.status(409).send({ error: "Could not find a free name to duplicate into" });
    }
    return reply.status(201).send(result.profile);
  });
}
