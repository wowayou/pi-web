// Manual regression for docs/http2.md; no model, Pi sessions, or system trust writes.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const OBSERVATION_MS = 800;
const REQUEST_MS = 5_000;
const TOTAL_MS = 120_000;
const children = new Set();
let directory;

async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: ${ms}ms deadline`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function until(check, label, ms = 3_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, label);
    await delay(20);
  }
}

function environment(home) {
  return { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: home,
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"), NO_COLOR: "1" };
}

function kill(child, signal) {
  if (!child?.pid) return;
  try {
    // Caddy and Playwright's browser are launched in their own process groups.
    process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
  } catch (error) { if (error.code !== "ESRCH") throw error; }
}

async function listen(server) {
  const ready = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await bounded(ready, 3_000, "loopback listen");
  return server.address().port;
}

async function availablePort() {
  const reservation = net.createServer();
  try { return await listen(reservation); }
  finally { await new Promise((resolve) => reservation.close(resolve)); }
}

async function tlsFixture(home, env) {
  const cert = join(home, "test.crt"), key = join(home, "test.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout", key, "-out", cert], { env, timeout: 10_000, stdio: "ignore" });
  return { cert: await readFile(cert), key: await readFile(key) };
}

async function fixture(tls) {
  const marker = randomUUID();
  const streams = new Map(), arrivals = [], probes = new Map(), sockets = new Set();
  const slow = { response: null, sent: 0, limit: 16 * 1024 * 1024 };
  const server = (tls ? https : http).createServer(tls ?? {}, (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end(`<!doctype html><title>Connection pool fixture</title><link rel="icon" href="data:,"><p>${marker}</p>`);
    } else if (url.pathname.startsWith("/events/")) {
      const id = url.pathname.slice(8);
      arrivals.push(id);
      streams.set(id, response);
      response.on("close", () => streams.delete(id));
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      response.write(`data: ${JSON.stringify({ id, ready: true })}\n\n`);
    } else if (url.pathname === "/probe") {
      const id = url.searchParams.get("id");
      const previous = probes.get(id);
      probes.set(id, { count: (previous?.count ?? 0) + 1, method: request.method,
        httpVersion: request.httpVersion, host: request.headers.host,
        forwardedProto: request.headers["x-forwarded-proto"] ?? null });
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) request.destroy();
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ id, body, marker }));
      });
    } else if (url.pathname === "/slow") {
      slow.response = response;
      response.on("close", () => { slow.response = null; });
      response.writeHead(200, { "content-type": "application/octet-stream" });
      const chunk = Buffer.alloc(64 * 1024, "x");
      const pump = () => {
        while (!response.destroyed && slow.sent < slow.limit) {
          slow.sent += chunk.length;
          if (!response.write(chunk)) return;
        }
      };
      response.on("drain", pump);
      pump();
    } else { response.writeHead(404).end(); }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const close = async () => {
    const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const socket of sockets) socket.destroy();
    await bounded(closed, 3_000, "fixture cleanup");
  };
  try {
    const port = await listen(server);
    return { marker, port, origin: `${tls ? "https" : "http"}://localhost:${port}`,
      streams, arrivals, probes, slow, close,
      emit(token) { for (const response of streams.values()) response.write(`data: ${JSON.stringify({ token })}\n\n`); } };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Fixture startup and cleanup failed"); }
    throw error;
  }
}

async function startCaddy(backend, home) {
  await mkdir(home);
  const env = environment(home);
  const port = await availablePort();
  const origin = `https://localhost:${port}`;
  const config = join(home, "Caddyfile");
  // The documentation's local recipe, with test-only admin and h2 controls.
  await writeFile(config, `{
  admin off
  auto_https disable_redirects
  skip_install_trust
  servers {
    protocols h1 h2
  }
}
localhost:${port} {
  bind 127.0.0.1
  tls internal
  reverse_proxy 127.0.0.1:${backend.port}
}
`);
  const child = spawn(process.env.E2E_CADDY_BIN || "caddy", ["run", "--config", config, "--adapter", "caddyfile"],
    { cwd: home, env, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"] });
  children.add(child);
  let diagnostic = "";
  child.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk).slice(-8192); });
  const exited = once(child, "close");
  // Attach a handler now: a missing executable can fail before readiness awaits it.
  let spawnError;
  exited.catch((error) => { spawnError = error; });
  const close = async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) kill(child, "SIGTERM");
      const [code, signal] = await bounded(exited, 5_000, "Caddy graceful shutdown");
      assert.equal(code, 0, `Caddy exited abnormally (${signal ?? code})`);
    } finally {
      kill(child, "SIGKILL");
      children.delete(child);
    }
  };
  try {
    const deadline = Date.now() + 10_000;
    let attempts = 0;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, `Caddy exited: ${diagnostic}`);
      assert.equal(child.signalCode, null, "Caddy was signalled during startup");
      const ca = await readFile(join(env.XDG_DATA_HOME, "caddy/pki/authorities/local/root.crt"))
        .catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
      if (ca) {
        try {
          attempts++;
          const body = await new Promise((resolve, reject) => {
            const request = https.get(origin, { ca, signal: AbortSignal.timeout(1_000) }, (response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (chunk) => { body += chunk; });
              response.on("error", reject);
              response.on("end", () => resolve(body));
            });
            request.on("error", reject);
          });
          // A port race must fail, never attach to a different server.
          assert.ok(body.includes(backend.marker), "Caddy must reach this exact fixture");
          console.log(JSON.stringify({ phase: "caddy-ready", strictCertificateCheck: true, attempts }));
          return { origin, ca, close };
        } catch (error) {
          // The CA file can exist before the localhost leaf has been issued.
          // Only retry that startup TLS alert or a refused listener, within the
          // same deadline; an invalid CA/hostname is never accepted or bypassed.
          if (error.code !== "ECONNREFUSED"
            && !(error.code === "EPROTO" && /SSL alert number 80/.test(error.message))) throw error;
        }
      }
      await delay(50);
    }
    throw new Error(`Caddy startup deadline: ${diagnostic}`);
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Caddy startup and cleanup failed"); }
    throw error;
  }
}

async function openPage(context, origin, ids, connections) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.responseReceived", ({ response }) => {
    if (new URL(response.url).pathname.startsWith("/events/")) {
      connections.push({ protocol: response.protocol, connectionId: response.connectionId });
    }
  });
  await page.goto(origin, { timeout: REQUEST_MS });
  await bounded(page.evaluate(async (ids) => {
    window.poolSources = ids.map((id) => new EventSource(`/events/${id}`));
    window.poolMessages = ids.map(() => []);
    window.poolErrors = 0;
    await Promise.all(window.poolSources.map((source, index) => new Promise((resolve, reject) => {
      source.onerror = () => { window.poolErrors++; reject(new Error("SSE error")); };
      source.onmessage = (event) => {
        window.poolMessages[index].push(JSON.parse(event.data));
        resolve();
      };
    })));
  }, ids), REQUEST_MS, "SSE ready");
  return page;
}

async function beginProbe(page, id, method) {
  await page.evaluate(({ id, method, timeout }) => {
    const url = new URL(`/probe?id=${id}`, location.href).href;
    const body = method === "POST" ? `echo-${id}` : "";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const start = performance.now();
    window.poolProbe = (async () => {
      try {
        const response = await fetch(url, { method, ...(body ? { body } : {}), cache: "no-store", signal: controller.signal });
        const json = await response.json();
        return { completed: true, status: response.status, durationMs: performance.now() - start,
          protocol: performance.getEntriesByName(url).at(-1)?.nextHopProtocol, ...json };
      } catch (error) { return { completed: false, error: String(error) }; }
      finally { clearTimeout(timer); }
    })();
  }, { id, method, timeout: REQUEST_MS });
}

async function finishProbe(page, backend, id, method, protocol) {
  const result = await bounded(page.evaluate(() => window.poolProbe), REQUEST_MS + 500, "browser fetch");
  assert.equal(result.completed, true, JSON.stringify(result));
  assert.equal(result.status, 200);
  assert.equal(result.id, id);
  assert.equal(result.body, method === "POST" ? `echo-${id}` : "");
  assert.equal(result.marker, backend.marker);
  assert.equal(result.protocol, protocol);
  assert.equal(backend.probes.get(id)?.count, 1, "no dropped or replayed request");
  assert.equal(backend.probes.get(id)?.method, method);
  assert.equal(backend.probes.get(id)?.httpVersion, "1.1", "h2 is browser-to-proxy, not proxy-to-backend");
  return result.durationMs;
}

async function delivery(pages, backend, count, token) {
  backend.emit(token);
  for (const page of pages) {
    await page.waitForFunction((token) => window.poolSources.every((source, i) =>
      source.readyState !== EventSource.OPEN || window.poolMessages[i].some((event) => event.token === token)), token,
    { timeout: REQUEST_MS });
  }
  const states = await Promise.all(pages.map((page) => page.evaluate(() => ({
    open: window.poolSources.filter((source) => source.readyState === EventSource.OPEN).length,
    errors: window.poolErrors,
  }))));
  assert.equal(states.reduce((sum, state) => sum + state.open, 0), count);
  assert.equal(states.reduce((sum, state) => sum + state.errors, 0), 0);
  assert.equal(backend.streams.size, count);
}

async function slowConsumer(proxy, backend) {
  const client = http2.connect(proxy.origin, { ca: proxy.ca, settings: { initialWindowSize: 16 * 1024 } });
  let unexpectedError;
  client.on("error", (error) => { unexpectedError = error; });
  try {
    await bounded(once(client, "connect"), 3_000, "strict TLS h2 connection");
    assert.equal(client.socket.alpnProtocol, "h2");
    const slow = client.request({ ":path": "/slow" });
    slow.on("error", (error) => { unexpectedError = error; });
    slow.end();
    await bounded(once(slow, "response"), 3_000, "slow response headers");
    // Leave its body unread. A bounded fixture must stop writing before its cap,
    // rather than filling an application-sized buffer in the proxy.
    await until(() => backend.slow.sent > 0, "slow upstream started");
    await delay(300);
    const sent = backend.slow.sent;
    await delay(300);
    assert.equal(backend.slow.sent, sent, "backpressure reaches the upstream");
    assert.ok(sent < backend.slow.limit, "unread response must not drain the bounded fixture");
    const checkPeer = async (id) => {
      const peer = client.request({ ":path": `/probe?id=${id}` });
      let body = "";
      peer.setEncoding("utf8");
      peer.on("data", (chunk) => { body += chunk; });
      peer.end();
      await bounded(once(peer, "end"), 2_000, "peer on the same h2 connection");
      const result = JSON.parse(body);
      assert.equal(result.marker, backend.marker);
      assert.equal(result.id, id);
      assert.equal(backend.probes.get(id)?.count, 1);
      assert.equal(unexpectedError, undefined, "the h2 connection stayed healthy");
    };
    await checkPeer("slow-peer-before-cancel");
    assert.equal(slow.closed, false, "the unread stream was not silently dropped");
    assert.ok(backend.slow.response, "the slow upstream is still attached before cancellation");
    slow.close(http2.constants.NGHTTP2_CANCEL);
    await until(() => backend.slow.response === null, "cancelled slow response releases upstream");
    // Cancellation must not tear down this connection. A browser on a separate
    // connection would not detect that regression; do not reconnect this client.
    await checkPeer("slow-peer-after-cancel");
    return { upstreamBytesBeforeBackpressure: sent, sameConnectionPeersBeforeAndAfterCancel: true };
  } finally { client.destroy(); }
}

async function scenario(browser, mode, pageCount, tls) {
  const backend = await fixture(mode === "https-h1" ? tls : undefined);
  let proxy, context;
  let primaryError;
  try {
    if (mode === "h2") proxy = await startCaddy(backend, join(directory, `caddy-${pageCount}`));
    const origin = proxy?.origin ?? backend.origin;
    const protocol = mode === "h2" ? "h2" : "http/1.1";
    const perPage = mode === "h2" ? (pageCount === 1 ? 12 : 2) : 6;
    const count = perPage * pageCount;
    context = await browser.newContext({ ignoreHTTPSErrors: mode !== "http", serviceWorkers: "block" });
    await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const connections = [], pages = [];
    for (let p = 0; p < pageCount; p++) {
      pages.push(await openPage(context, origin, Array.from({ length: perPage }, (_, i) => `${p}-${i}`), connections));
    }
    assert.equal(backend.arrivals.length, count, "no SSE reconnects");
    // CDP's observation can arrive after the page's first SSE message.
    await until(() => connections.length >= count, "all SSE protocol observations arrived");
    assert.equal(connections.length, count);
    assert.ok(connections.every((connection) => connection.protocol === protocol));
    assert.ok(connections.every((connection) => Number.isInteger(connection.connectionId) && connection.connectionId > 0),
      "CDP supplied physical connection ids, not missing values counted as one");
    const result = { mode, pages: pageCount, logicalStreams: count, protocol,
      observedBrowserConnections: new Set(connections.map((connection) => connection.connectionId)).size };
    await delivery(pages, backend, count, "all-open");
    if (mode !== "h2") {
      await beginProbe(pages[0], "held", "GET");
      await delay(OBSERVATION_MS);
      assert.equal(backend.probes.has("held"), false, "H1 request must still be queued in the browser");
      const released = performance.now();
      await pages[0].evaluate(() => window.poolSources[0].close());
      await finishProbe(pages[0], backend, "held", "GET", protocol);
      assert.ok(performance.now() - released < 2_000, "H1 request recovers when one connection is freed");
      Object.assign(result, { observationMs: OBSERVATION_MS, reachedBackendWhileFull: false, recoveredAfterRelease: true });
    } else {
      const samples = [];
      for (let i = 0; i < pageCount + 20; i++) {
        const page = pages[i % pageCount], id = `probe-${i}`, method = i % 2 ? "POST" : "GET";
        await beginProbe(page, id, method);
        const elapsed = await finishProbe(page, backend, id, method, protocol);
        assert.equal(backend.probes.get(id).forwardedProto, "https");
        assert.equal(backend.probes.get(id).host, new URL(origin).host);
        if (i >= pageCount) samples.push(elapsed);
      }
      const sorted = [...samples].sort((a, b) => a - b);
      Object.assign(result, { warmupRequests: pageCount, measuredRequests: samples.length,
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maxMs: sorted.at(-1), samples });
      console.log(JSON.stringify({ phase: "latency", ...result }));
      assert.ok(result.p95Ms < 500, "local warm p95 < 500ms");
      assert.ok(result.maxMs < 2_000, "local warm max < 2s");
      await delivery(pages, backend, count, "after-probes");
      result.slowConsumer = await slowConsumer(proxy, backend);
      await delivery(pages, backend, count, "after-slow-consumer");
      await pages[0].evaluate(() => window.poolSources[0].close());
      await until(() => backend.streams.size === count - 1, "cancelled SSE releases upstream subscription");
      await delivery(pages, backend, count - 1, "after-stream-cancel");
      await pages[0].close();
      await until(() => backend.streams.size === count - perPage, "closed page releases its subscriptions");
      await delivery(pages.slice(1), backend, count - perPage, "after-page-close");
      assert.equal(backend.arrivals.length, count, "cancellation did not reconnect other streams");
      result.cancellationPassed = true;
    }
    console.log(JSON.stringify({ phase: "scenario-pass", ...result }));
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const failures = primaryError ? [primaryError] : [];
    for (const [label, close] of [["browser context", () => context?.close()], ["Caddy", () => proxy?.close()], ["fixture", backend.close]]) {
      try { await bounded(Promise.resolve().then(close), 7_000, `${label} cleanup`); }
      catch (error) { failures.push(error); }
    }
    if (failures.length > (primaryError ? 1 : 0)) throw new AggregateError(failures, "Scenario or cleanup failed");
  }
}

let browserServer;
let checksPassed = false;
const watchdog = setTimeout(() => {
  for (const child of children) kill(child, "SIGKILL");
  if (directory) rmSync(directory, { recursive: true, force: true });
  console.error("FAIL: hard deadline; test processes killed");
  process.exit(1);
}, TOTAL_MS);
const interrupt = () => {
  for (const child of children) kill(child, "SIGKILL");
  if (directory) rmSync(directory, { recursive: true, force: true });
  process.exit(1);
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  directory = await mkdtemp(join(tmpdir(), "pi-web-http-pool-"));
  const env = environment(directory);
  const version = execFileSync(process.env.E2E_CADDY_BIN || "caddy", ["version"], { env, timeout: 3_000, encoding: "utf8" }).trim();
  const tls = await tlsFixture(directory, env);
  browserServer = await chromium.launchServer({ executablePath: chromium.executablePath(), headless: true, env,
    args: ["--disable-background-networking", "--disable-component-update", "--disable-quic", "--no-proxy-server"], timeout: 15_000 });
  children.add(browserServer.process());
  const browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 5_000 });
  console.log(JSON.stringify({ phase: "start", caddy: version, browser: browser.version(),
    syntheticBackend: true, actualPiWebValidated: false, browserCertificateTrustValidated: false, hardDeadlineMs: TOTAL_MS }));
  for (const [mode, pages] of [["http", 1], ["https-h1", 1], ["h2", 1], ["h2", 8]]) {
    await scenario(browser, mode, pages, tls);
  }
  checksPassed = true;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    if (browserServer) {
      await bounded(browserServer.close(), 5_000, "browser shutdown");
      children.delete(browserServer.process());
    }
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    for (const child of children) kill(child, "SIGKILL");
    if (directory) await rm(directory, { recursive: true, force: true });
    clearTimeout(watchdog);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
if (checksPassed && !process.exitCode) console.log(JSON.stringify({ phase: "pass", scenarios: 4, cleanupComplete: true }));
