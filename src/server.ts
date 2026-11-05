import { createReadStream } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { Config } from "./config.ts";

/** request path -> file in the data directory and its content type */
const FILES: Record<string, [string, string]> = {
  "/": ["status.html", "text/html; charset=utf-8"],
  "/status.html": ["status.html", "text/html; charset=utf-8"],
  "/visits.csv": ["visits.csv", "text/csv; charset=utf-8"],
};

/** serves status.html and visits.csv from the data directory */
export function serveStatus(cfg: Config, log: (...m: unknown[]) => void): Server {
  const server = createServer((req, res) => {
    const file = FILES[new URL(req.url ?? "/", "http://localhost").pathname];
    if (!file || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(404).end("not found\n");
      return;
    }
    const stream = createReadStream(join(cfg.dataDir, file[0]));
    stream.on("open", () => {
      res.writeHead(200, { "content-type": file[1], "cache-control": "no-store" });
      if (req.method === "HEAD") return void (stream.destroy(), res.end());
      stream.pipe(res);
    });
    stream.on("error", () => {
      if (!res.headersSent) res.writeHead(503).end("not written yet\n");
      else res.destroy();
    });
  });
  server.on("error", (e) => log(`status page server: ${e.message}`));
  server.listen(cfg.statusPort, () => log(`status page on http://localhost:${cfg.statusPort}/`));
  return server;
}
