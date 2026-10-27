# Pair another browser

A dev server admits a browser only after it pairs. The server prints a one-time pairing URL at startup, `bin.ts pair` mints more, and the pairing page also takes a pasted token. A paired browser keeps a session cookie and opens straight to the threads view.

## Sub-features

- `pair-startup` pairs with the startup URL the dev runner prints.
- `pair-fresh` mints a fresh one-time URL for another browser.
- `pair-paste` pairs by pasting a token into the pairing page.

## How to get to it (user POV)

- Open the pairing URL in a browser.
- Open the web origin unpaired, which shows `Pair with this environment` with a `Pairing token` box and `Continue`.

## Driving it with t3v

Preconditions:

- `node $T3V doctor` prints no `FAIL`.
- The startup URL is spent, because `browser open` used it.

- **Mint a URL.** Run `node $T3V pair`. It writes a fresh URL on the web origin to the scratch `pairing-url` file and prints only the file's path.
- **Pair a second helper browser.** Give it its own run name, so it gets its own profile. Run `T3V_RUN=<run>-b node $T3V pair` and `T3V_RUN=<run>-b node $T3V browser open`. It prints `paired`, and `T3V_RUN=<run>-b node $T3V doctor` reports `the t3v browser is paired`. Stop it with `T3V_RUN=<run>-b node $T3V down`, which stops only that browser, because that run started no server.
- **Pair the Browser panel by paste.** Inside a T3 thread, open the web origin in the panel, then paste the token, the part after `#token=`, into the form. Call `preview_type` with `locator: "role=textbox[name='Pairing token']"` and `preview_click` with `locator: "role=button[name='Continue']"`. `preview_wait_for` with `locator: "role=navigation[name='Threads']"` returns.
- **Proof.** A screenshot of the threads view from each browser, and `doctor`'s session line.

## Gotchas

- A token works once. `browser open` spends the startup URL and deletes the file, so mint another with `pair` for each new browser.
- A tab that is already on `/pair` ignores a new `#token=` in the URL, because only the hash changes and the page does not reload. Paste the token into the form, or reload.
- A server restart on a fresh `.t3` invalidates every old session. A tab from before the restart lands on the pairing page.
- `pair` prints the URL into a mode 0600 file, never to the terminal. Never paste a token or pairing URL into a commit, PR or reply.
- The startup URL carries admin scopes, which Settings > Connections needs. `bin.ts pair` mints standard scopes.
