/**
 * Configuration, from environment variables only (set them in compose).
 * See README.md for a description of each.
 */
export type Config = {
  /** origin of the protected site, e.g. https://app.example.com */
  targetUrl: string;
  /** paths visited, in turn */
  paths: string[];
  /** simulated clients visiting in parallel */
  clients: number;
  /** seconds between the starts of two visits of one client */
  intervalSeconds: number;
  /** random variation of the interval, as a share of it (0..1) */
  jitter: number;
  /** a client starts a new session (cookies, client id) after this many visits; 0 = never */
  newSessionEvery: number;
  /** send an X-Client-ID header, so the gate tells the clients apart */
  sendClientId: boolean;
  clientIdPrefix: string;
  /** give up on a visit after this long (challenge included) */
  visitTimeoutSeconds: number;
  /** stop after this long; 0 = run forever */
  durationHours: number;
  /** stop after this many visits in total; 0 = no limit */
  maxVisits: number;
  /** path prefix of the gate's endpoints */
  gatePrefix: string;
  /** after passing, open a WebSocket to this path; empty = no check */
  websocketPath: string;
  /** where status.txt, visits.csv and state.json are written */
  dataDir: string;
  statusIntervalSeconds: number;
  /** keep counting from the previous run's state.json */
  resume: boolean;
};

export function loadConfig(env = process.env): Config {
  const str = (k: string, d: string) => (env[k] ?? "").trim() || d;
  const num = (k: string, d: number) => {
    const v = (env[k] ?? "").trim();
    if (!v) return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a non-negative number, got "${v}"`);
    return n;
  };
  const bool = (k: string, d: boolean) => {
    const v = (env[k] ?? "").trim().toLowerCase();
    return v ? ["1", "true", "yes", "on"].includes(v) : d;
  };

  const targetUrl = str("TARGET_URL", "");
  if (!targetUrl) throw new Error("TARGET_URL is required, e.g. https://app.example.com");
  new URL(targetUrl); // validates

  const cfg: Config = {
    targetUrl: targetUrl.replace(/\/+$/, ""),
    paths: str("TARGET_PATHS", "/")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => (p.startsWith("/") ? p : `/${p}`)),
    clients: Math.max(1, Math.round(num("CLIENTS", 1))),
    intervalSeconds: num("INTERVAL_SECONDS", 60),
    jitter: Math.min(1, num("JITTER", 0.2)),
    newSessionEvery: Math.round(num("NEW_SESSION_EVERY", 0)),
    sendClientId: bool("SEND_CLIENT_ID", true),
    clientIdPrefix: str("CLIENT_ID_PREFIX", "tester"),
    visitTimeoutSeconds: num("VISIT_TIMEOUT_SECONDS", 300),
    durationHours: num("DURATION_HOURS", 0),
    maxVisits: Math.round(num("MAX_VISITS", 0)),
    gatePrefix: str("GATE_PREFIX", "/_keephuman").replace(/\/+$/, ""),
    websocketPath: str("WEBSOCKET_PATH", ""),
    dataDir: str("DATA_DIR", "./data"),
    statusIntervalSeconds: Math.max(1, num("STATUS_INTERVAL_SECONDS", 30)),
    resume: bool("RESUME", true),
  };
  return cfg;
}
