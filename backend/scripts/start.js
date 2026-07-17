#!/usr/bin/env node
// Single production entrypoint that decides web-vs-worker at runtime via
// SERVICE_ROLE, since both are the same backend codebase deployed as two
// separate Railway services from the same build — the deploy tooling has no
// per-service "custom start command" available without a dashboard, but
// `railway variables --set` per service works fine, so SERVICE_ROLE is set
// there instead (SERVICE_ROLE=web on photosphere-api, SERVICE_ROLE=worker on
// photosphere-worker). Unset/anything else defaults to web, matching local
// `npm start`'s existing single-service behavior.
const { execSync, spawn } = require("node:child_process");

const role = process.env.SERVICE_ROLE ?? "web";

if (role === "worker") {
  execSync("node dist/worker.js", { stdio: "inherit" });
} else if (role === "combined") {
  // Render's free tier only offers free *web* services (background workers
  // are paid-only), so this mode runs migrations once, then the API and the
  // BullMQ worker as two child processes of one service. If either child
  // dies, exit so the platform restarts the whole service.
  execSync("npx prisma migrate deploy", { stdio: "inherit" });
  const api = spawn("node", ["dist/server.js"], { stdio: "inherit" });
  const worker = spawn("node", ["dist/worker.js"], { stdio: "inherit" });
  const bail = (code) => process.exit(code ?? 1);
  api.on("exit", bail);
  worker.on("exit", bail);
} else {
  // Migrations run from the web service only, once, before the server
  // starts accepting traffic — not from the worker too, to avoid two
  // services racing `prisma migrate deploy` against each other on boot.
  execSync("npx prisma migrate deploy", { stdio: "inherit" });
  execSync("node dist/server.js", { stdio: "inherit" });
}
