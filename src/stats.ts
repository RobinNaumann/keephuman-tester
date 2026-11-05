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

  /** writes status.txt and state.json */
  async write(done = false) {
    await writeAtomic(this.path("state.json"), JSON.stringify(this.state));
    await writeAtomic(this.path("status.txt"), this.render(done));
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

    const lines: string[] = [];
    const kv = (k: string, v: string | number) => lines.push(`  ${k.padEnd(30)} ${v}`);
    const head = (t: string) => lines.push("", t, "-".repeat(t.length));

    lines.push(`KeepHuman tester status - ${iso(now)}${done ? " (finished)" : ""}`);
    lines.push("=".repeat(lines[0]!.length));
    kv("target", cfg.targetUrl);
    kv("paths", cfg.paths.join(", "));
    kv("clients / interval", `${cfg.clients} clients, a visit every ${cfg.intervalSeconds}s each (±${Math.round(cfg.jitter * 100)}%)`);
    kv("counting since", `${iso(s.firstStartedAt)} (${dur(now - s.firstStartedAt)}, run ${s.runs})`);
    kv("this run since", `${iso(this.runStartedAt)} (${dur(now - this.runStartedAt)})`);
    kv("visits in progress", this.active);

    head("Visits");
    kv("total", `${total} (${rate(total, elapsedH)}/h overall, ${recent.length} in the last hour)`);
    kv("reached the application", `${passed} (${pct(passed, total)})`);
    for (const o of OUTCOMES) kv(`  ${o}`, `${s.visits[o]} (${pct(s.visits[o], total)})`);
    kv("last hour", OUTCOMES.map((o) => `${o} ${recent.filter((x) => x.outcome === o).length}`).join(", "));

    head("Challenges");
    kv("received", s.challenges);
    kv("submissions accepted", `${s.accepted} (${pct(s.accepted, s.accepted + s.rejected)})`);
    kv("submissions rejected", s.rejected);
    kv("no challenge available (404)", s.noChallenge);
    kv("tasks solved, by provider", Object.entries(s.tasks).map(([p, n]) => `${p} ${n}`).join(", ") || "none");

    head("Timing (all kept samples | last hour)");
    const solveAll = s.samples.flatMap((x) => x.solveMs);
    const solveRecent = recent.flatMap((x) => x.solveMs);
    const visitAll = s.samples.filter((x) => x.outcome === "passed").map((x) => x.totalMs);
    const visitRecent = recent.filter((x) => x.outcome === "passed").map((x) => x.totalMs);
    kv("challenge solve time", `${summary(solveAll)} | ${summary(solveRecent)}`);
    kv("visit with challenge", `${summary(visitAll)} | ${summary(visitRecent)}`);
    kv("visit without challenge", summary(s.samples.filter((x) => x.outcome === "passed_directly").map((x) => x.totalMs)));

    head("Responses");
    kv("final page HTTP status", Object.entries(s.statuses).map(([k, n]) => `${k}: ${n}`).join(", ") || "none");
    if (cfg.websocketPath)
      kv(`WebSocket ${cfg.websocketPath}`, `${s.websocket.ok} ok, ${s.websocket.failed} failed (${pct(s.websocket.ok, s.websocket.ok + s.websocket.failed)} ok)`);

    head("Clients (this run)");
    for (const [id, c] of [...this.clients].sort())
      kv(id, `${c.visits} visits, last ${c.last} at ${iso(c.lastAt)}`);
    if (!this.clients.size) lines.push("  none yet");

    head(`Recent problems (last ${MAX_ERRORS})`);
    for (const e of [...s.errors].reverse()) lines.push(`  ${iso(e.t)}  ${e.client}  ${e.message}`);
    if (!s.errors.length) lines.push("  none");

    lines.push("", "Per-visit details: visits.csv in the same directory.", "");
    return lines.join("\n");
  }
}

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
