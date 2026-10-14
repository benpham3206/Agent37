// Password-protected proxy for the team's Agent-37 bots (127.0.0.1:8800, published by cloudflared).
//   /                     index of bots (admin login)
//   /<path>/              that bot's control page; /<path>/viewer/ its first-person view;
//   /<path>/status|chat|hud.js  its status JSON, chat, HUD script
// Logins: admin (VIEWER_USER/VIEWER_PASS) opens everything and is Ben's login for /ben/.
//         <path> / PASS_<path> opens only /<path>/.
import http from 'http'; import net from 'net'; import fs from 'fs'; import crypto from 'crypto';
const env = Object.fromEntries(fs.readFileSync(new URL('./share-viewer.env', import.meta.url), 'utf8').trim().split(/\r?\n/).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const team = JSON.parse(fs.readFileSync(new URL('./team.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const basic = (u, p) => Buffer.from('Basic ' + Buffer.from(`${u}:${p}`).toString('base64'));
const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
const ADMIN = basic(env.VIEWER_USER, env.VIEWER_PASS);
const users = Object.fromEntries(team.filter(t => env['PASS_' + t.path]).map(t => [t.path, basic(t.path, env['PASS_' + t.path])]));
const who = h => { const got = Buffer.from(h || ''); if (eq(got, ADMIN)) return 'admin'; for (const [p, w] of Object.entries(users)) if (eq(got, w)) return p; return null; };
const allowed = (user, path) => user === 'admin' || user === path;

// '/vikram/viewer/x' -> {bot, port, path:'/x'}
function route(url) {
  const m = /^\/([a-z0-9_-]+)(\/.*)?$/.exec(url.split('?')[0]); const t = m && team.find(t => t.path === m[1]);
  if (!t) return null;
  const rest = url.slice(t.path.length + 1) || '/';
  if (rest.startsWith('/viewer/')) return { t, port: t.viewer, path: rest.slice(7) };
  if (/^\/(status|chat|hud\.js)(\?|$)/.test(rest)) return { t, port: t.status, path: rest };
  return { t, port: t.control, path: rest };
}
const deny = (res, code = 401) => { res.writeHead(code, code === 401 ? { 'WWW-Authenticate': 'Basic realm="agent37"' } : {}); res.end(code === 401 ? 'auth required' : 'not your bot'); };
const fwd = (req, port) => { const h = { ...req.headers, host: `127.0.0.1:${port}` }; delete h.authorization; return h; };

const server = http.createServer((req, res) => {
  const user = who(req.headers.authorization); if (!user) return deny(res);
  if (req.url === '/' || req.url === '/index.html') {
    const mine = team.filter(t => allowed(user, t.path));
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<!doctype html><title>Agent37 bots</title><body style="font:16px sans-serif;margin:2em"><h1>Agent37 bots</h1><ul>${mine.map(t => `<li><a href="/${t.path}/">${t.bot}</a></li>`).join('')}</ul>`);
  }
  const r = route(req.url); if (!r) { res.writeHead(404); return res.end('no such bot'); }
  if (!allowed(user, r.t.path)) return deny(res, 403);
  if (r.path === '/' && !req.url.endsWith('/')) { res.writeHead(301, { Location: `/${r.t.path}/` }); return res.end(); }
  if (r.port === r.t.viewer && r.path === '' ) { res.writeHead(301, { Location: `/${r.t.path}/viewer/` }); return res.end(); }
  const file = r.path.split('?')[0], P = '/' + r.t.path;
  const rewrite = r.port === r.t.control && ['/', '/index.html', '/app.js'].includes(file);
  const headers = fwd(req, r.port); if (rewrite) delete headers['accept-encoding'];
  const up = http.request({ host: '127.0.0.1', port: r.port, method: req.method, path: r.path, headers }, u => {
    if (!rewrite) { res.writeHead(u.statusCode, u.headers); return u.pipe(res); }
    let body = ''; u.setEncoding('utf8'); u.on('data', c => body += c); u.on('end', () => {
      if (file === '/app.js') {
        body = body.replace('`${location.protocol}//${location.hostname}:${viewerPort}`', '`${location.origin}' + P + '/viewer/`')
                   .replace('`${protocol}//${location.host}/control`', '`${protocol}//${location.host}' + P + '/control`');
      } else {
        body = body.replace('href="/style.css"', `href="${P}/style.css"`).replace('src="/app.js"', `src="${P}/app.js"`)
                   .replace('</body>', `<script>window.A37_PREFIX=${JSON.stringify(P)}</script><script src="${P}/hud.js"></script></body>`);
      }
      const h = { ...u.headers }; delete h['content-length']; delete h.etag; h['cache-control'] = 'no-store';
      res.writeHead(u.statusCode, h); res.end(body);
    });
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(`${r.t.bot} is not running`); }); req.pipe(up);
});
server.on('upgrade', (req, sock, head) => {
  const user = who(req.headers.authorization), r = route(req.url);
  if (!user || !r || !allowed(user, r.t.path)) { sock.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="agent37"\r\n\r\n'); return; }
  const up = net.connect({ host: '127.0.0.1', port: r.port }, () => {
    up.write(`${req.method} ${r.path} HTTP/1.1\r\n` + Object.entries(fwd(req, r.port)).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head); up.pipe(sock); sock.pipe(up);
  });
  up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
});
server.listen(8800, '127.0.0.1', () => console.log('team proxy on 127.0.0.1:8800: ' + team.map(t => '/' + t.path + '/').join(' ')));
