"use strict";

const { fork } = require("node:child_process");
const http = require("node:http");

const children = new Map();
const scripts = ["albo.js", "ammtrasp.js"];
let shuttingDown = false;

function startChild(script) {
  const previous = children.get(script);
  const failures = previous?.failures || 0;
  const child = fork(script, [], { stdio: "inherit" });
  const state = { child, failures, startedAt: Date.now(), restartTimer: null };
  children.set(script, state);
  console.log(`[supervisor] ${script} avviato (pid=${child.pid})`);

  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    const livedMs = Date.now() - state.startedAt;
    state.failures = livedMs >= 5 * 60 * 1000 ? 1 : state.failures + 1;
    const delayMs = Math.min(60_000, 1000 * (2 ** Math.min(state.failures - 1, 6)));
    console.error(
      `[supervisor] ${script} terminato (code=${code}, signal=${signal}); riavvio tra ${delayMs}ms`
    );
    state.restartTimer = setTimeout(() => startChild(script), delayMs);
  });
}

for (const script of scripts) startChild(script);

const healthPort = Number(process.env.HEALTH_PORT || 3042);
const healthServer = http.createServer((request, response) => {
  const live = request.url === "/live";
  const readyPath = request.url === "/health" || request.url === "/ready";
  if (!live && !readyPath) {
    response.writeHead(404).end();
    return;
  }
  const childStates = Object.fromEntries(scripts.map(script => {
    const state = children.get(script);
    return [script, Boolean(state?.child && state.child.exitCode === null && !state.restartTimer)];
  }));
  const ready = Object.values(childStates).every(Boolean);
  response.writeHead(live || ready ? 200 : 503, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: live || ready, ready, children: childStates }));
});
healthServer.listen(healthPort, "127.0.0.1", () => {
  console.log(`[supervisor] health server in ascolto sulla porta ${healthPort}`);
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[supervisor] arresto per ${signal}`);
  for (const state of children.values()) {
    if (state.restartTimer) clearTimeout(state.restartTimer);
    state.child?.kill("SIGTERM");
  }
  healthServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
