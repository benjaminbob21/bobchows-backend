/**
 * Study B benchmark harness (research protocol, Phase 6)
 *
 * Compares the two real-time sync mechanisms for group-order status:
 *   - HTTP polling (baseline): the client re-fetches the group-order state
 *     every 5 seconds.
 *   - WebSocket (Socket.IO): the server pushes groupOrder:update events to a
 *     room per group order the moment a participant pays or a status changes.
 *
 * The harness simulates state changes by POSTing to /api/benchmark/emit
 * (dev-only endpoint on the backend) at a configurable rate — this stands in
 * for real Stripe payment confirmations so the transport itself is measured.
 *
 * Metrics collected (per protocol):
 *   - update latency p95 <= 500ms  (server emit -> client receive)
 *   - read-your-write consistency p95 <= 1s (state change -> client sees it;
 *     for polling this is dominated by the poll interval)
 *   - error rate <= 1%
 *
 * Usage (run from bobchows-backend):
 *   GROUP_ORDER_ID=<id> node research/benchmark/study-b.mjs \
 *     --users 50 --duration 60 --mode websocket
 *   GROUP_ORDER_ID=<id> node research/benchmark/study-b.mjs \
 *     --users 50 --duration 60 --mode polling
 */

import { io as createSocketClient } from "socket.io-client";
import { program } from "commander";

const API_BASE_URL = process.env.VITE_API_BASE_URL || "http://localhost:7001";
const GROUP_ORDER_ID = process.env.GROUP_ORDER_ID;

program
  .option("--users <n>", "number of concurrent simulated clients", "10")
  .option("--duration <s>", "benchmark duration in seconds", "30")
  .option("--mode <mode>", "websocket | polling", "websocket")
  .option("--emit-interval <ms>", "how often to simulate a state change", "3000")
  .parse(process.argv);

const opts = program.opts();
const users = parseInt(opts.users, 10);
const duration = parseInt(opts.duration, 10);
const mode = opts.mode;
const emitInterval = parseInt(opts.emitInterval, 10);

if (!GROUP_ORDER_ID) {
  console.error("Set GROUP_ORDER_ID env var to the group order under test");
  process.exit(1);
}

const latencies = [];
const consistencyGaps = [];
const errors = [];
let updatesReceived = 0;
let updatesSent = 0;

const now = () => Date.now();

const end = (p = []) => {
  if (!p.length) return { count: 0 };
  const sum = p.reduce((a, b) => a + b, 0);
  const mean = sum / p.length;
  const sorted = [...p].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const max = sorted[sorted.length - 1];
  const min = sorted[0];
  return { count: p.length, mean, p50, p95, max, min };
};

const fmt = (s) => (s.count ? `n=${s.count} mean=${s.mean.toFixed(1)} p50=${s.p50} p95=${s.p95} max=${s.max}` : "no observations");

const report = (results) => {
  console.log(`\n=== Study B — ${mode} (${users} users, ${duration}s) ===`);
  console.log(`Group order under test: ${GROUP_ORDER_ID}`);
  console.log(`Updates simulated: ${updatesSent}, delivered: ${updatesReceived}`);
  console.log(`\nUpdate latency (ms): ${fmt(results.latencies)}`);
  console.log(`Read-your-write consistency (ms): ${fmt(results.consistency)}`);
  console.log(`Error rate: ${results.errorRate.toFixed(2)}% (${errors.length} errors / ${results.totalOps} ops)`);
};

// Timestamp of the most recent simulated state change (for read-your-write
// consistency measurement on the polling arm).
let lastEmitTime = 0;

// Triggers a simulated state change on the server every emitInterval ms.
const startTriggerLoop = () => {
  const fire = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/benchmark/emit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupOrderId: GROUP_ORDER_ID }),
      });
      if (res.ok) {
        updatesSent++;
        lastEmitTime = now();
      } else errors.push(`emit ${res.status}`);
    } catch (e) {
      errors.push(`emit error ${e.message}`);
    }
  };
  const id = setInterval(fire, emitInterval);
  fire();
  return id;
};

const runWebSocket = async () => {
  const clients = [];
  const startedAt = now();

  for (let i = 0; i < users; i++) {
    const socket = createSocketClient(API_BASE_URL, {
      transports: ["websocket"],
      reconnection: true,
      timeout: 5000,
    });

    socket.on("connect", () => {
      socket.emit("groupOrder:join", GROUP_ORDER_ID);
    });

    socket.on("groupOrder:update", (payload) => {
      updatesReceived++;
      const emitAt = payload?.serverTime || startedAt;
      const latency = now() - emitAt;
      latencies.push(latency);
      consistencyGaps.push(latency);
    });

    socket.on("connect_error", () => errors.push("websocket connect_error"));
    socket.on("disconnect", (reason) => {
      if (reason === "io server disconnect") errors.push("server disconnect");
    });
    clients.push(socket);
  }

  const trigger = startTriggerLoop();

  // Wait for clients to connect and join before emitting.
  await new Promise((r) => setTimeout(r, 2000));
  await new Promise((r) => setTimeout(r, duration * 1000));

  clearInterval(trigger);
  clients.forEach((c) => c.disconnect());

  const total = updatesReceived + errors.length;
  report({
    latencies: end(latencies),
    consistency: end(consistencyGaps),
    errorRate: total ? (errors.length / total) * 100 : 0,
    totalOps: total,
  });
};

const runPolling = async () => {
  const pollIntervalMs = 5000;
  const startedAt = now();
  let polls = 0;

  const poll = async () => {
    try {
      const t0 = now();
      const res = await fetch(`${API_BASE_URL}/api/benchmark/state?groupOrderId=${GROUP_ORDER_ID}`);
      const latency = now() - t0;
      latencies.push(latency);
      polls++;
      if (!res.ok) errors.push(`poll ${res.status}`);
    } catch (e) {
      errors.push(`poll error ${e.message}`);
    }
  };

  const trigger = startTriggerLoop();
  await new Promise((r) => setTimeout(r, 2000));

  // Polling clients: each user polls every pollIntervalMs. A change made at
  // time T is observed at the next poll boundary, so read-your-write
  // consistency = time until the next successful poll after a change.
  const clients = Array.from({ length: users }, () => ({ lastPoll: 0, active: false }));

  while (now() - startedAt < duration * 1000) {
    for (const c of clients) {
      if (now() - c.lastPoll >= pollIntervalMs && !c.active) {
        c.active = true;
        c.lastPoll = now();
        poll()
          .then(() => {
            // If a state change was simulated since the last observation, this
            // poll is the moment a read-your-write client would see it.
            if (lastEmitTime > 0) {
              consistencyGaps.push(now() - lastEmitTime);
              lastEmitTime = 0;
            }
          })
          .finally(() => (c.active = false));
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  clearInterval(trigger);
  report({
    latencies: end(latencies),
    consistency: end(consistencyGaps),
    errorRate: polls ? (errors.length / polls) * 100 : 0,
    totalOps: polls,
  });
};

console.log(`Starting ${mode} benchmark against ${API_BASE_URL}...`);
if (mode === "websocket") {
  await runWebSocket();
} else {
  await runPolling();
}
