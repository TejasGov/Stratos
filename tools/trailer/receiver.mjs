// Trailer frame receiver: the capture page POSTs JPEG frames to /<shot>/<index>;
// they land in <out>/<shot>/<index>.jpg.  Usage: node tools/trailer/receiver.mjs <out-dir>
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const out = process.argv[2];
if (!out) throw new Error("usage: node receiver.mjs <out-dir>");
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
http
  .createServer(async (req, res) => {
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
    const match = /^\/([a-z0-9-]+)\/(\d{1,5})$/.exec(req.url ?? "");
    if (req.method !== "POST" || !match) return res.writeHead(400, cors).end("bad request");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const dir = path.join(out, match[1]);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${match[2].padStart(5, "0")}.jpg`), Buffer.concat(chunks));
    res.writeHead(200, cors).end("ok");
  })
  .listen(8788, "127.0.0.1", () => console.log("receiver on 127.0.0.1:8788 →", out));
