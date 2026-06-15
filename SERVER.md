# Git Graph+ Standalone Web Server

A standalone Node web server that serves the Git Graph+ Svelte UI as a remote
web app. It reuses the extension's git engine and the exact same message-bus
protocol, proxied over a WebSocket instead of VS Code's `postMessage`. This lets
you browse and operate on repos on a remote/headless machine from a browser.

> This is part of, and tracks, upstream **Git Graph Plus**. The UI is the same
> webview the VS Code extension ships; only the transport and host differ.

## Access model

The server binds to `127.0.0.1` by default. The intended way to reach it is:

- **SSH port-forward:** `ssh -L 8080:127.0.0.1:8080 you@host`, then open
  `http://localhost:8080` locally.
- **Tailscale (or similar mesh VPN):** bind to the Tailscale interface / set
  `HOST` accordingly and reach it over the tailnet.

SSH/Tailscale is the real security boundary. The optional `AUTH_TOKEN` adds a
single shared-token login (session cookie) as defense-in-depth, but it is not a
substitute for a private network — do not expose the server on a public
interface.

## Quick start

```bash
npm install && cd webview-ui && npm install && cd ..
npm run build          # builds the extension + webview UI
npm run build:server   # bundles src/server -> dist/server.js
cp .env.example .env   # then edit .env (at least ROOT_DIR)
npm run serve          # node dist/server.js
```

Open `http://127.0.0.1:8080` (through your SSH tunnel / tailnet).

## Configuration (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | TCP port to listen on. |
| `HOST` | `127.0.0.1` | Bind address. Keep on loopback unless behind a VPN. |
| `AUTH_TOKEN` | *(empty)* | If set, require this token (login → session cookie) for the UI and WebSocket. Empty = open access. |
| `ROOT_DIR` | `~/projects` | Directory scanned for git repos, submodules, and nested repos (depth 3). `~` expanded. |
| `GIT_BINARY_PATH` | *(empty)* | Override the git executable; empty uses `git` from PATH. |
| `AUTO_REFRESH` | `true` | Watch each repo's `.git` dir and refresh on change. |
| `AUTO_FETCH` | `true` | Periodic background `git fetch`. |
| `AUTO_FETCH_INTERVAL_MS` | `180000` | Auto-fetch interval (ms). |
| `LOCALE` | `auto` | UI language: `auto` (follows `LANG`), `en`, `ko`, `zh-cn`. |
| `GRAPH_SORT_ORDER` | `topological` | `author-date`, `date`, or `topological`. |
| `BRANCH_BADGE_BAR_THICKNESS` | `thin` | `thin`, `medium`, or `thick`. |

## Credentials

The server stores **no** git credentials. Git operations run as the OS user that
launched the server and use that user's normal git auth:

- **HTTPS:** your configured credential helper (e.g. `git credential-store`,
  the system keychain, or `gh auth setup-git`).
- **SSH:** your SSH agent / keys (`ssh-add`, `~/.ssh/...`).

If a push/pull fails with an auth error, fix it the same way you would on the
command line on that machine (e.g. `gh auth login`, `ssh-add`).

## What's unsupported vs the VS Code extension

The web UI is the same, but actions that depend on the VS Code editor degrade to
a transient notice instead of opening an editor:

- Open file / open diff in an editor pane, open the 3-way merge editor.
- Open the Source Control view, open a worktree in a new window.
- Native save dialog and system-clipboard writes (the server sends the patch
  content / text back to the browser to handle locally where straightforward).

All core git operations — log/graph, branches, tags, stashes, worktrees,
checkout, merge, rebase (incl. interactive), cherry-pick, revert, reset, push,
pull, fetch, bisect, git-flow, LFS, submodules — run through the shared git
engine exactly as in the extension.
