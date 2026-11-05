import type { BrowserContext, Page } from "playwright";
import type { Config } from "./config.ts";

export type Outcome =
  /** reached the application after solving one or more challenges */
  | "passed"
  /** reached the application without a challenge (session still trusted) */
  | "passed_directly"
  /** the gate rejected a submission */
  | "rejected"
  /** still on the gate when the visit timed out */
  | "timeout"
  /** the application answered with an error status */
  | "app_error"
  /** navigation failed (connection refused, DNS, browser crash, ...) */
  | "error";

export type VisitResult = {
  startedAt: number;
  client: string;
  path: string;
  outcome: Outcome;
  /** start of the visit until the application page loaded */
  totalMs: number;
  /** HTTP status of the last page loaded */
  status: number | null;
  challenges: number;
  /** time from receiving each challenge until its submission was answered */
  solveMs: number[];
  /** tasks received, by provider */
  tasks: Record<string, number>;
  accepted: number;
  rejected: number;
  /** times the gate had no challenge to give (404) */
  noChallenge: number;
  /** WebSocket check after passing: null if not configured or not reached */
  websocket: "ok" | "failed" | null;
  error: string | null;
};

/** the gate's challenge page (static/index.html of the middleware) */
const isGatePage = (page: Page) =>
  page
    .evaluate(() => !!document.querySelector("progress#progress") && /keephuman/i.test(document.title))
    .catch(() => null); // null: page is navigating

export async function visit(
  ctx: BrowserContext,
  cfg: Config,
  client: string,
  path: string,
): Promise<VisitResult> {
  const startedAt = Date.now();
  const deadline = startedAt + cfg.visitTimeoutSeconds * 1000;
  const r: VisitResult = {
    startedAt,
    client,
    path,
    outcome: "error",
    totalMs: 0,
    status: null,
    challenges: 0,
    solveMs: [],
    tasks: {},
    accepted: 0,
    rejected: 0,
    noChallenge: 0,
    websocket: null,
    error: null,
  };

  const page = await ctx.newPage();
  let challengeAt: number | null = null;
  let sawGate = false;

  // the challenge page reports a rejected submission with an alert. The
  // submit response itself is often unreadable: the page reloads at once.
  let submissions = 0;
  page.on("dialog", (d) => {
    if (/rejected/i.test(d.message())) r.rejected++;
    d.dismiss().catch(() => {});
  });
  page.on("response", async (res) => {
    const req = res.request();
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) r.status = res.status();
    const p = new URL(res.url()).pathname;
    try {
      if (p === `${cfg.gatePrefix}/challenge`) {
        if (res.status() === 404) return void r.noChallenge++;
        if (!res.ok()) return;
        const c = await res.json();
        r.challenges++;
        challengeAt = Date.now();
        for (const id of Object.keys(c.tasks ?? {})) {
          const provider = id.split(":")[0]!;
          r.tasks[provider] = (r.tasks[provider] ?? 0) + 1;
        }
      } else if (p === `${cfg.gatePrefix}/submit`) {
        submissions++;
        if (challengeAt) r.solveMs.push(Date.now() - challengeAt);
        challengeAt = null;
      }
    } catch {
      // body unavailable, e.g. the page navigated away
    }
  });

  try {
    await page.goto(cfg.targetUrl + path, {
      waitUntil: "load",
      timeout: cfg.visitTimeoutSeconds * 1000,
    });
    // the gate's script solves the challenge and reloads; wait until the
    // application is shown, a submission is rejected, or time runs out
    for (;;) {
      if (r.rejected > 0) {
        r.outcome = "rejected";
        break;
      }
      const gate = await isGatePage(page);
      if (gate === true) sawGate = true;
      if (gate === false) {
        const loaded = await page.evaluate(() => document.readyState === "complete").catch(() => false);
        if (loaded) {
          r.outcome =
            r.status !== null && r.status >= 400 ? "app_error" : sawGate || r.challenges > 0 ? "passed" : "passed_directly";
          break;
        }
      }
      if (Date.now() > deadline) {
        r.outcome = "timeout";
        break;
      }
      await page.waitForTimeout(250);
    }
    r.totalMs = Date.now() - startedAt;
    r.accepted = Math.max(0, submissions - r.rejected);

    if (cfg.websocketPath && (r.outcome === "passed" || r.outcome === "passed_directly"))
      r.websocket = await checkWebSocket(page, cfg.websocketPath);
  } catch (e) {
    r.outcome = "error";
    r.error = e instanceof Error ? e.message.split("\n")[0]! : String(e);
    r.totalMs = Date.now() - startedAt;
  } finally {
    await page.close().catch(() => {});
  }
  return r;
}

/** opens a WebSocket from the page (same origin, cookies included) */
async function checkWebSocket(page: Page, path: string): Promise<"ok" | "failed"> {
  return page
    .evaluate(
      (path) =>
        new Promise<"ok" | "failed">((resolve) => {
          const url = new URL(path, location.href);
          url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
          const ws = new WebSocket(url);
          const timer = setTimeout(() => (ws.close(), resolve("failed")), 10_000);
          ws.onopen = () => (clearTimeout(timer), ws.close(1000), resolve("ok"));
          ws.onerror = () => (clearTimeout(timer), resolve("failed"));
        }),
      path,
    )
    .catch(() => "failed" as const);
}
