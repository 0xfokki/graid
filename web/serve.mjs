// Local preview server for the site.
//
// Serves the files in this directory and forwards /api to the live agent, so a
// page opened here behaves exactly as it does in production - the strip, the
// feed and the scoreboard all fill in. Without the proxy the browser would block
// those calls as cross-origin and half the page would sit empty.
//
//   node web/serve.mjs                http://localhost:5173
//   PAGE=base.html node web/serve.mjs   serve another page from this directory
import { createServer } from "http";
import { readFileSync, existsSync, statSync } from "fs";
import { join, extname } from "path";
import { fileURLToPath } from "url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT ?? 5173);
const UPSTREAM = process.env.UPSTREAM ?? "https://graid-ai.com";
const PAGE = process.env.PAGE ?? "index.html";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".webp": "image/webp",
  ".mp4": "video/mp4", ".svg": "image/svg+xml", ".json": "application/json",
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  if (url.pathname.startsWith("/api/")) {
    try {
      const r = await fetch(UPSTREAM + url.pathname + url.search, {
        headers: { accept: req.headers.accept ?? "*/*" },
      });
      res.writeHead(r.status, {
        "content-type": r.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      });
      if (!r.body) return res.end();
      for await (const chunk of r.body) res.write(chunk);
      return res.end();
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "upstream unreachable", detail: e.message }));
    }
  }

  const name = url.pathname === "/" ? PAGE : url.pathname.slice(1);
  const file = join(HERE, name);
  if (!file.startsWith(HERE) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404); return res.end("not found");
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(readFileSync(file));
}).listen(PORT, () => {
  console.log(`preview  http://localhost:${PORT}   (${PAGE})`);
  console.log(`api      proxied to ${UPSTREAM}`);
});
