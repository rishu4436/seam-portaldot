// Local bridge between a SEAM run (Node) and a browser page that holds the wallet extension.
// Binds 127.0.0.1 only, requires a random token, answers only that token. It carries payloads out and signatures back;
// assembleSignedExtrinsic still verifies every signature against the payload, so a bad answer is refused.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = (f) => fileURLToPath(new URL(f, import.meta.url));

export async function startBridge({ address, port = 0, requestTimeoutMs = 10 * 60_000 }) {
  const token = randomBytes(16).toString('hex');
  const queue = []; const waiting = []; const pending = new Map(); let seq = 0; let finished = false; let connected;
  const connectedP = new Promise((r) => (connected = r));
  const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
  const drain = () => { while (queue.length && waiting.length) { const res = waiting.shift(); const job = queue.shift(); send(res, 200, { id: job.id, label: job.label, payload: job.payload }); } };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) return send(res, 403, { error: 'local only' });
      if (url.pathname === '/') { if (url.searchParams.get('t') !== token) return send(res, 403, 'bad token', 'text/plain'); return send(res, 200, readFileSync(here('page.html')), 'text/html'); }
      if (url.pathname === '/bridge-client.js') return send(res, 200, readFileSync(here('bridge-client.js')), 'text/javascript');
      if (url.searchParams.get('t') !== token) return send(res, 403, { error: 'bad token' });
      if (url.pathname === '/api/hello') { const b = await body(req); connected(b.accounts); return send(res, 200, { address }); }
      if (url.pathname === '/api/next') {
        if (finished) return send(res, 410, { done: true });
        waiting.push(res); res.on('close', () => { const i = waiting.indexOf(res); if (i >= 0) waiting.splice(i, 1); });
        setTimeout(() => { const i = waiting.indexOf(res); if (i >= 0) { waiting.splice(i, 1); send(res, 204, ''); } }, 25_000);
        return drain();
      }
      if (url.pathname === '/api/signature') {
        const b = await body(req); const p = pending.get(b.id);
        if (!p) return send(res, 404, { error: 'unknown request' });
        pending.delete(b.id); clearTimeout(p.timer);
        if (b.error) p.reject(new Error(`the wallet declined: ${b.error}`)); else p.resolve({ signature: b.signature });
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) { send(res, 500, { error: String(e.message) }); }
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, token, url: `${base}/?t=${token}`, address,
    /** Resolves once a browser page has connected its extension. */
    waitForWallet: () => connectedP,
    /** Same shape SEAM's walletFrom wants: payload in, { signature } out. */
    signPayload(payload, label = 'transaction') {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('no signature came back in time')); }, requestTimeoutMs);
        pending.set(id, { resolve, reject, timer }); queue.push({ id, label, payload }); drain();
      });
    },
    async close() { finished = true; for (const r of waiting.splice(0)) send(r, 410, { done: true }); server.close(); }
  };
}
