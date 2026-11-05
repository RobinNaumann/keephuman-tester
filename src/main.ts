import { chromium, type Browser, type BrowserContext } from "playwright";
import { loadConfig, type Config } from "./config.ts";
import { serveStatus } from "./server.ts";
import { Stats } from "./stats.ts";
import { visit } from "./visit.ts";

const log = (...m: unknown[]) => console.log(new Date().toISOString(), ...m);

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;

/** the shared browser, relaunched if it crashed */
async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  launching ??= chromium
    .launch({
      headless: true,
      // containers have a small /dev/shm
      args: ["--disable-dev-shm-usage"],
    })
    .then((b) => {
      log(`chromium ${b.version()} started`);
      b.on("disconnected", () => log("chromium disconnected, relaunching on next visit"));
      browser = b;
      launching = null;
      return b;
    })
    .catch((e) => {
      launching = null;
      throw e;
    });
  return launching;
}

async function main() {
  const cfg = loadConfig();
  const stats = new Stats(cfg);
  await stats.init();
  log(
    `testing ${cfg.targetUrl} (${cfg.paths.join(", ")}) with ${cfg.clients} client(s), ` +
      `one visit every ${cfg.intervalSeconds}s each; status in ${cfg.dataDir}/status.html`,
  );
  const server = cfg.statusPort ? serveStatus(cfg, log) : null;

  const endAt = cfg.durationHours > 0 ? Date.now() + cfg.durationHours * 3600_000 : Infinity;
  let started = 0;
  let stopping = false;
  let stopReason = "";
  const stop = (why: string) => {
    if (stopping) return;
    stopping = true;
    stopReason = why;
    log(`stopping (${why}), waiting for running visits...`);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const statusTimer = setInterval(
    () => stats.write().catch((e) => log("could not write status:", e)),
    cfg.statusIntervalSeconds * 1000,
  );
  await stats.write();

  const runClient = async (i: number) => {
    // spread the clients' first visits over one interval
    await sleep((cfg.intervalSeconds * 1000 * i) / cfg.clients, () => stopping);
    let ctx: BrowserContext | null = null;
    let generation = 0;
    let visits = 0;
    let id = "";

    while (!stopping) {
      if (Date.now() >= endAt) return stop("duration reached");
      if (cfg.maxVisits && started >= cfg.maxVisits) return stop("visit limit reached");
      started++;
      const t0 = Date.now();
      try {
        const b = await getBrowser();
        if (!ctx || !b.contexts().includes(ctx) || (cfg.newSessionEvery && visits >= cfg.newSessionEvery)) {
          await ctx?.close().catch(() => {});
          generation++;
          visits = 0;
          id = `${cfg.clientIdPrefix}-${i + 1}${generation > 1 ? `.${generation}` : ""}`;
          ctx = await b.newContext({
            extraHTTPHeaders: cfg.sendClientId ? { "X-Client-ID": id } : {},
            ignoreHTTPSErrors: true,
          });
        }
        const path = cfg.paths[(started - 1) % cfg.paths.length]!;
        stats.active++;
        const r = await visit(ctx, cfg, id, path).finally(() => stats.active--);
        visits++;
        await stats.record(r);
        const solve = r.solveMs.length ? `, solved in ${r.solveMs.map((ms) => (ms / 1000).toFixed(1) + "s").join("+")}` : "";
        log(`${id} ${path}: ${r.outcome} in ${(r.totalMs / 1000).toFixed(1)}s${solve}${r.error ? ` (${r.error})` : ""}`);
      } catch (e) {
        log(`${id || `client ${i + 1}`}: ${e instanceof Error ? e.message : e}`);
        ctx = null;
      }
      const interval = cfg.intervalSeconds * 1000 * (1 + cfg.jitter * (2 * Math.random() - 1));
      await sleep(Math.max(0, t0 + interval - Date.now()), () => stopping);
    }
  };

  await Promise.all(Array.from({ length: cfg.clients }, (_, i) => runClient(i)));
  clearInterval(statusTimer);
  await stats.write(true);
  await browser?.close().catch(() => {});
  log(`done: ${stats.totalVisits} visits`);
  // finished on its own (duration or visit limit): stay up, so a compose
  // restart policy doesn't start the test over, unless asked to exit
  const signalled = stopReason.startsWith("SIG");
  if (!signalled && !["1", "true"].includes(process.env.EXIT_WHEN_DONE ?? "")) {
    log("finished; idling until stopped (EXIT_WHEN_DONE=1 exits instead)");
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", () => resolve());
      process.once("SIGINT", () => resolve());
    });
  }
  server?.close();
  server?.closeAllConnections();
}

/** sleeps, waking up early once `cancel` returns true */
async function sleep(ms: number, cancel: () => boolean) {
  const end = Date.now() + ms;
  while (Date.now() < end && !cancel()) await new Promise((r) => setTimeout(r, Math.min(1000, end - Date.now())));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
