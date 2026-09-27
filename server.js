/**
 * SLATE DevOps OS - Production Server Entrypoint
 * Ideal for cPanel "Setup Node.js App" (Phusion Passenger), VPS (PM2/Systemd), or local execution.
 */

const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");

const dev = process.env.NODE_ENV !== "production";
const port = process.env.PORT || 3000;
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error("Error handling request:", req.url, err);
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  }).listen(port, (err) => {
    if (err) throw err;
    console.log(`[SLATE DEVOPS OS] Running on port ${port} (mode: ${dev ? "development" : "production"})`);
  });
});
