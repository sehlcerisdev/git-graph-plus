interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

/**
 * Returns the messaging API. In VS Code, `acquireVsCodeApi` is injected into the
 * webview and we use it verbatim. In standalone/browser mode (the web server)
 * there is no such global, so we return a drop-in object backed by a WebSocket:
 * outbound `postMessage` is JSON-sent to the server, and inbound server messages
 * are re-dispatched as `window` 'message' events so the existing
 * `window.addEventListener('message', ...)` handlers work unchanged.
 */
export function getVsCodeApi(): VsCodeApi {
  if (!api) {
    if (typeof acquireVsCodeApi === 'function') {
      api = acquireVsCodeApi();
    } else {
      api = createWebSocketApi();
    }
  }
  return api;
}

const SAVE_PATCH_PREFIX = '__SAVE_PATCH__:';
const CLIPBOARD_PREFIX = '__CLIPBOARD__:';

/**
 * Fulfil a web-host editor-action message in the browser. Returns true when the
 * message was consumed (and must NOT be re-dispatched to the app), false
 * otherwise. savePatch streams `__SAVE_PATCH__:<fileName>\n<content>` and
 * copyToClipboard streams `__CLIPBOARD__:<text>`.
 */
function handleWebAction(data: unknown): boolean {
  const msg = data as { type?: string; payload?: { message?: string } } | null;
  if (!msg || msg.type !== 'error' || typeof msg.payload?.message !== 'string') {
    return false;
  }
  const message = msg.payload.message;

  if (message.startsWith(SAVE_PATCH_PREFIX)) {
    const rest = message.slice(SAVE_PATCH_PREFIX.length);
    const nl = rest.indexOf('\n');
    const fileName = nl >= 0 ? rest.slice(0, nl) : 'patch.patch';
    const content = nl >= 0 ? rest.slice(nl + 1) : '';
    try {
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      /* download is best-effort */
    }
    return true;
  }

  if (message.startsWith(CLIPBOARD_PREFIX)) {
    const text = message.slice(CLIPBOARD_PREFIX.length);
    try {
      void navigator.clipboard?.writeText(text);
    } catch {
      /* clipboard is best-effort */
    }
    return true;
  }

  return false;
}

function createWebSocketApi(): VsCodeApi {
  let ws: WebSocket | null = null;
  let connected = false;
  const outbox: string[] = [];
  let reconnectDelay = 500;

  const loc = window.location;
  const wsUrl = `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/`;

  const flush = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (outbox.length) {
      ws.send(outbox.shift() as string);
    }
  };

  const connect = () => {
    ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      connected = true;
      reconnectDelay = 500;
      flush();
    });

    ws.addEventListener('message', (ev) => {
      let data: unknown;
      try {
        data = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      // The web host can't touch the user's disk or clipboard, so savePatch /
      // copyToClipboard are delivered as magic-prefixed messages that the
      // browser fulfils locally (download / clipboard write). Intercept them
      // here so they never surface as raw text in the error banner. Everything
      // else is re-dispatched unchanged.
      if (handleWebAction(data)) return;

      // Re-dispatch as a window 'message' event so App.svelte's existing
      // window.addEventListener('message', ...) handlers receive it unchanged.
      window.dispatchEvent(new MessageEvent('message', { data }));
    });

    ws.addEventListener('close', () => {
      connected = false;
      // Best-effort reconnect with capped backoff.
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    });

    ws.addEventListener('error', () => {
      try { ws?.close(); } catch { /* ignore */ }
    });
  };

  connect();

  return {
    postMessage(message: unknown): void {
      const json = JSON.stringify(message);
      if (connected && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      } else {
        outbox.push(json);
      }
    },
    getState(): unknown {
      try {
        const raw = sessionStorage.getItem('ggp-state');
        return raw ? JSON.parse(raw) : undefined;
      } catch {
        return undefined;
      }
    },
    setState(state: unknown): void {
      try {
        sessionStorage.setItem('ggp-state', JSON.stringify(state));
      } catch {
        /* ignore quota / serialization errors */
      }
    },
  };
}
