// vitest setup for the webview project. Runs before every webview test file.
//
// The webview production code calls `acquireVsCodeApi()` — a global injected
// by the VS Code webview host. In a jsdom/happy-dom test environment that
// global doesn't exist, so any module that imports `vscode-api.ts` (most of
// the modals do) blows up at module-eval time. We install a recording stub
// so tests can both render those components and inspect the messages they
// send back to the extension.

interface PostedMessage { data: unknown; }
declare global {
  // eslint-disable-next-line no-var
  var __postedMessages: PostedMessage[];
  function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void };
}

globalThis.__postedMessages = [];

(globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage(msg: unknown) {
    globalThis.__postedMessages.push({ data: msg });
  },
  getState() { return undefined; },
  setState(_s: unknown) { /* noop */ },
});

// Each test gets a fresh outbox so assertions don't see leftovers from a
// previous file's setup. Use `globalThis` rather than module-scope so the
// helper survives the cross-file boundary vitest puts between tests.
import { beforeEach } from 'vitest';
beforeEach(() => {
  globalThis.__postedMessages = [];
});

export {};
