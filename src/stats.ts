import { access, appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Outcome, VisitResult } from "./visit.ts";

const OUTCOMES: Outcome[] = ["passed", "passed_directly", "rejected", "timeout", "app_error", "error"];
/** per-visit samples kept for percentiles */
const MAX_SAMPLES = 50_000;
const MAX_ERRORS = 15;

type Sample = { t: number; outcome: Outcome; totalMs: number; solveMs: number[] };

type State = {
  firstStartedAt: number;
  runs: number;
  visits: Record<Outcome, number>;
  challenges: number;
  accepted: number;
  rejected: number;
  noChallenge: number;
  tasks: Record<string, number>;
  statuses: Record<string, number>;
  websocket: { ok: number; failed: number };
  samples: Sample[];
  errors: { t: number; client: string; message: string }[];
};

const emptyState = (): State => ({
  firstStartedAt: Date.now(),
  runs: 0,
  visits: Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>,
  challenges: 0,
  accepted: 0,
  rejected: 0,
  noChallenge: 0,
  tasks: {},
  statuses: {},
  websocket: { ok: 0, failed: 0 },
  samples: [],
  errors: [],
});

export class Stats {
  private state = emptyState();
  private runStartedAt = Date.now();
  /** this run only: client -> visits and last outcome */
  private clients = new Map<string, { visits: number; last: Outcome; lastAt: number }>();
  public active = 0;

  private cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  private path(f: string) {
    return join(this.cfg.dataDir, f);
  }

  async init() {
    await mkdir(this.cfg.dataDir, { recursive: true });
    if (this.cfg.resume) {
      try {
        const saved = JSON.parse(await readFile(this.path("state.json"), "utf8"));
        this.state = { ...emptyState(), ...saved, visits: { ...emptyState().visits, ...saved.visits } };
      } catch {
        // first run
      }
    }
    this.state.runs++;
    try {
      await access(this.path("visits.csv"));
    } catch {
      await writeFile(this.path("visits.csv"), CSV_HEADER);
    }
  }

  async record(v: VisitResult) {
    const s = this.state;
    s.visits[v.outcome]++;
    s.challenges += v.challenges;
    s.accepted += v.accepted;
    s.rejected += v.rejected;
    s.noChallenge += v.noChallenge;
    for (const [p, n] of Object.entries(v.tasks)) s.tasks[p] = (s.tasks[p] ?? 0) + n;
    if (v.status !== null) s.statuses[v.status] = (s.statuses[v.status] ?? 0) + 1;
    if (v.websocket) s.websocket[v.websocket]++;
    s.samples.push({ t: v.startedAt, outcome: v.outcome, totalMs: v.totalMs, solveMs: v.solveMs });
    if (s.samples.length > MAX_SAMPLES) s.samples.splice(0, s.samples.length - MAX_SAMPLES);
    if (v.error || v.outcome === "rejected" || v.outcome === "timeout" || v.outcome === "app_error") {
      s.errors.push({
        t: v.startedAt,
        client: v.client,
        message: v.error ?? `${v.outcome}${v.status ? ` (HTTP ${v.status})` : ""} on ${v.path}`,
      });
      if (s.errors.length > MAX_ERRORS) s.errors.shift();
    }
    const c = this.clients.get(v.client) ?? { visits: 0, last: v.outcome, lastAt: 0 };
    this.clients.set(v.client, { visits: c.visits + 1, last: v.outcome, lastAt: v.startedAt });

    await appendFile(this.path("visits.csv"), csvLine(v));
  }

  get totalVisits() {
    return Object.values(this.state.visits).reduce((a, b) => a + b, 0);
  }

  /** writes status.html and state.json */
  async write(done = false) {
    await writeAtomic(this.path("state.json"), JSON.stringify(this.state));
    await writeAtomic(this.path("status.html"), this.render(done));
  }

  render(done = false): string {
    const s = this.state;
    const now = Date.now();
    const total = this.totalVisits;
    const hourAgo = now - 3600_000;
    const recent = s.samples.filter((x) => x.t >= hourAgo);
    const passed = s.visits.passed + s.visits.passed_directly;
    const elapsedH = (now - s.firstStartedAt) / 3600_000;
    const cfg = this.cfg;

    const out: string[] = [];
    const table = (head: string[], rows: (string | number)[][]) =>
      out.push(
        "<table>",
        head.length ? `<tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>` : "",
        ...rows.map((r) => `<tr>${r.map((c, i) => (i || head.length ? `<td>${c}</td>` : `<th>${c}</th>`)).join("")}</tr>`),
        "</table>",
      );
    const section = (t: string) => out.push(`<h2>${esc(t)}</h2>`);
    const outcome = (o: Outcome) => `<span class="${o}">${o}</span>`;

    table([], [
      ["target", esc(cfg.targetUrl)],
      ["paths", esc(cfg.paths.join(", "))],
      ["clients / interval", `${cfg.clients} clients, a visit every ${cfg.intervalSeconds}s each (±${Math.round(cfg.jitter * 100)}%)`],
      ["counting since", `${iso(s.firstStartedAt)} (${dur(now - s.firstStartedAt)}, run ${s.runs})`],
      ["this run since", `${iso(this.runStartedAt)} (${dur(now - this.runStartedAt)})`],
      ["visits in progress", this.active],
    ]);

    section("Visits");
    table([], [
      ["total", `${total} (${rate(total, elapsedH)}/h overall, ${recent.length} in the last hour)`],
      ["reached the application", `${passed} (${pct(passed, total)})`],
    ]);
    table(
      ["outcome", "all", "", "last hour"],
      OUTCOMES.map((o) => [outcome(o), s.visits[o], pct(s.visits[o], total), recent.filter((x) => x.outcome === o).length]),
    );

    section("Challenges");
    table([], [
      ["received", s.challenges],
      ["submissions accepted", `${s.accepted} (${pct(s.accepted, s.accepted + s.rejected)})`],
      ["submissions rejected", s.rejected],
      ["no challenge available (404)", s.noChallenge],
      ["tasks solved, by provider", esc(Object.entries(s.tasks).map(([p, n]) => `${p} ${n}`).join(", ") || "none")],
    ]);

    section("Timing");
    const solveAll = s.samples.flatMap((x) => x.solveMs);
    const solveRecent = recent.flatMap((x) => x.solveMs);
    const visitAll = s.samples.filter((x) => x.outcome === "passed").map((x) => x.totalMs);
    const visitRecent = recent.filter((x) => x.outcome === "passed").map((x) => x.totalMs);
    const directAll = s.samples.filter((x) => x.outcome === "passed_directly").map((x) => x.totalMs);
    const directRecent = recent.filter((x) => x.outcome === "passed_directly").map((x) => x.totalMs);
    table(["", "all kept samples", "last hour"], [
      ["challenge solve time", summary(solveAll), summary(solveRecent)],
      ["visit with challenge", summary(visitAll), summary(visitRecent)],
      ["visit without challenge", summary(directAll), summary(directRecent)],
    ]);

    section("Responses");
    const responses: (string | number)[][] = [
      ["final page HTTP status", Object.entries(s.statuses).map(([k, n]) => `${k}: ${n}`).join(", ") || "none"],
    ];
    if (cfg.websocketPath)
      responses.push([
        `WebSocket ${esc(cfg.websocketPath)}`,
        `${s.websocket.ok} ok, ${s.websocket.failed} failed (${pct(s.websocket.ok, s.websocket.ok + s.websocket.failed)} ok)`,
      ]);
    table([], responses);

    section("Clients (this run)");
    if (this.clients.size)
      table(
        ["client", "visits", "last outcome", "at"],
        [...this.clients].sort().map(([id, c]) => [esc(id), c.visits, outcome(c.last), iso(c.lastAt)]),
      );
    else out.push("<p>none yet</p>");

    section(`Recent problems (last ${MAX_ERRORS})`);
    if (s.errors.length)
      table(["time", "client", "problem"], [...s.errors].reverse().map((e) => [iso(e.t), esc(e.client), esc(e.message)]));
    else out.push("<p>none</p>");

    out.push(`<p>Per-visit details: <a href="visits.csv">visits.csv</a> in the same directory.</p>`);

    const title = `KeepHuman tester${done ? " (finished)" : ""}`;
    // reload with the status file; the age warns when the tester stopped writing it
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
${done ? "" : `<meta http-equiv="refresh" content="${cfg.statusIntervalSeconds}">`}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${esc(title)}</h1>
<p id="updated" data-t="${now}" data-interval="${cfg.statusIntervalSeconds}" data-done="${done}">updated ${iso(now)}</p>
${out.join("\n")}
<script>${SCRIPT}</script>
</body>
</html>
`;
  }
}

const STYLE = `
:root { color-scheme: light dark; --muted: #888; --line: #8884; --good: #1a7f37; --bad: #cf222e; --warn: #9a6700; }
@media (prefers-color-scheme: dark) { :root { --good: #3fb950; --bad: #f85149; --warn: #d29922; } }
body { font: 14px/1.5 system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; }
h1 { font-size: 1.4rem; margin-bottom: 0; }
h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; }
#updated { color: var(--muted); margin-top: .2rem; }
#updated.stale { color: var(--bad); font-weight: 600; }
table { border-collapse: collapse; margin: .5rem 0; }
th, td { text-align: left; padding: .2rem 1.5rem .2rem 0; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; }
td { font-variant-numeric: tabular-nums; }
.passed, .passed_directly { color: var(--good); }
.rejected, .error, .app_error { color: var(--bad); }
.timeout { color: var(--warn); }
`;

const SCRIPT = `
const el = document.getElementById("updated");
const t = Number(el.dataset.t), interval = Number(el.dataset.interval), done = el.dataset.done === "true";
const tick = () => {
  const age = Math.round((Date.now() - t) / 1000);
  const stale = !done && age > 3 * interval + 10;
  el.textContent = "updated " + new Date(t).toISOString().replace(/\\.\\d+Z$/, "Z") + " (" + age + "s ago)" +
    (done ? ", finished" : stale ? ", not updated for a while: is the tester still running?" : "");
  el.classList.toggle("stale", stale);
};
tick();
setInterval(tick, 1000);
`;

const CSV_HEADER =
  "started_at,client,path,outcome,total_ms,http_status,challenges,solve_ms,accepted,rejected,no_challenge,tasks,websocket,error\n";

function csvLine(v: VisitResult): string {
  const cell = (x: unknown) => {
    const s = x === null || x === undefined ? "" : String(x);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return (
    [
      iso(v.startedAt),
      v.client,
      v.path,
      v.outcome,
      v.totalMs,
      v.status,
      v.challenges,
      v.solveMs.join(" "),
      v.accepted,
      v.rejected,
      v.noChallenge,
      Object.entries(v.tasks).map(([p, n]) => `${p}:${n}`).join(" "),
      v.websocket,
      v.error,
    ]
      .map(cell)
      .join(",") + "\n"
  );
}

async function writeAtomic(path: string, data: string) {
  await writeFile(`${path}.tmp`, data);
  await rename(`${path}.tmp`, path);
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
const pct = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
const rate = (n: number, h: number) => (h > 0 ? (n / h).toFixed(1) : "n/a");

function dur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** n, median, p95, max in seconds */
function summary(xs: number[]): string {
  if (!xs.length) return "n/a";
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  const f = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  return `n=${s.length} median ${f(q(0.5))} p95 ${f(q(0.95))} max ${f(s.at(-1)!)}`;
}
