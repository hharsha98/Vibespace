import Fastify from "fastify";
import { AGENT_IDS } from "@vibedeck/shared";

const VERSION = "0.0.0";
const PORT = 4317;

/**
 * Builds the Fastify app without starting a listener. Kept separate from
 * the `listen()` call below so tests can exercise the app in-process (via
 * `app.inject()`) without binding a real network port.
 */
export function buildApp() {
  const app = Fastify({ logger: false });

  app.get("/api/health", async () => ({
    status: "ok" as const,
    version: VERSION,
    agents: AGENT_IDS,
  }));

  return app;
}

// Only start listening when this file is run directly (e.g. via `tsx
// watch src/index.ts`), not when it's imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildApp();
  app
    .listen({ port: PORT, host: "0.0.0.0" })
    .then(() => {
      console.log(`vibedeck server listening on http://localhost:${PORT}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
