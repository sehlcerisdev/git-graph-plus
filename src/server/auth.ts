import * as crypto from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';

// Minimal single-shared-token auth. When AUTH_TOKEN is empty the server is
// open (SSH/Tailscale is assumed to be the real network boundary). When set,
// both the HTML/static routes and the WebSocket upgrade require a valid cookie,
// obtained by POSTing the token to /login.

const COOKIE_NAME = 'ggp_session';

export class Auth {
  private readonly enabled: boolean;
  private readonly token: string;
  // HMAC key derived from the token; the session cookie is the HMAC of a fixed
  // marker so we can verify it without server-side session storage.
  private readonly sessionValue: string;

  constructor(token: string) {
    this.token = token;
    this.enabled = token.trim().length > 0;
    this.sessionValue = this.enabled
      ? crypto.createHmac('sha256', token).update('git-graph-plus-session').digest('hex')
      : '';
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Returns true if the request carries a valid session cookie (or auth disabled). */
  isAuthed(req: IncomingMessage): boolean {
    if (!this.enabled) return true;
    const cookies = parseCookies(req.headers.cookie);
    const v = cookies[COOKIE_NAME];
    return !!v && timingSafeEqualStr(v, this.sessionValue);
  }

  /** Validates a submitted token against the configured one (constant-time). */
  checkToken(submitted: string): boolean {
    if (!this.enabled) return true;
    return timingSafeEqualStr(submitted, this.token);
  }

  /** Set-Cookie header value granting a session. */
  cookieHeader(): string {
    // Session cookie (no Max-Age) so it clears when the browser closes.
    return `${COOKIE_NAME}=${this.sessionValue}; HttpOnly; SameSite=Strict; Path=/`;
  }

  /** Handle GET /login (form) and POST /login (token submission). Returns true if handled. */
  handleLoginRoute(req: IncomingMessage, res: ServerResponse, body: string): boolean {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loginPage(false));
      return true;
    }
    if (req.method === 'POST') {
      const params = new URLSearchParams(body);
      const token = params.get('token') ?? '';
      if (this.checkToken(token)) {
        res.writeHead(302, { 'Set-Cookie': this.cookieHeader(), Location: '/' });
        res.end();
      } else {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(loginPage(true));
      }
      return true;
    }
    return false;
  }

  /** Redirect an unauthenticated request to the login page. */
  redirectToLogin(res: ServerResponse): void {
    res.writeHead(302, { Location: '/login' });
    res.end();
  }
}

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function loginPage(error: boolean): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Git Graph+ — Sign in</title>
<style>
  body { font-family: system-ui, sans-serif; background:#1e1e1e; color:#ccc; display:flex; height:100vh; margin:0; align-items:center; justify-content:center; }
  form { background:#252526; padding:2rem; border-radius:8px; border:1px solid #333; min-width:280px; }
  h1 { font-size:1.1rem; margin:0 0 1rem; }
  input { width:100%; box-sizing:border-box; padding:.5rem; margin-bottom:1rem; background:#3c3c3c; border:1px solid #555; color:#eee; border-radius:4px; }
  button { width:100%; padding:.5rem; background:#0e639c; color:#fff; border:none; border-radius:4px; cursor:pointer; }
  button:hover { background:#1177bb; }
  .err { color:#f48771; font-size:.85rem; margin-bottom:.75rem; }
</style></head>
<body>
  <form method="POST" action="/login">
    <h1>Git Graph+</h1>
    ${error ? '<div class="err">Invalid token.</div>' : ''}
    <input type="password" name="token" placeholder="Access token" autofocus autocomplete="current-password" />
    <button type="submit">Sign in</button>
  </form>
</body></html>`;
}
