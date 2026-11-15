# CI and browser regression tests

Adapted from @Nuctori's CI/E2E proposal in #617 and #599. The performance
scanner, reverse reader, sidebar changes, and timing benchmarks are not included.

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

The script starts and stops its own Turbopack dev server on an available
loopback port. Run it in a checkout without an active dev server; Next.js
shares `.next/dev/lock` within a checkout. All fixtures are created before
startup in a temporary `PI_CODING_AGENT_DIR` and removed on completion.
No model credentials or existing Pi sessions are needed. Git is required for
the linked-worktree fixture.

CI runs lint, type checking, and unit tests in one job. A separate job builds
the application in a clean checkout and runs the same browser tests with
`E2E_SERVER_MODE=start` against `next start`. Do not build in a checkout used
for development.

Coverage:

- A 5,000-message session opens with exactly the last 50 entries, bounded
  detail/context responses, and no browser errors.
- Desktop and mobile scrolling load two consecutive older pages. Each response
  has the expected IDs, no gaps or duplicates, and the messages appear once in
  the chat. A small session checks pagination through the root.
- Branch context follows the selected leaf and excludes the other branch.
- Markdown, code blocks, and real tool-call/tool-result blocks render.
- Chat width and font size persist, existing drafts resize, and short settings
  panels keep every language option reachable on desktop and mobile.
- Interface/chat and monospace font lists and weights apply live, survive
  refresh, sync between tabs and reset independently without changing width or
  font size. Headings and Markdown emphasis retain their weights.
- On a desktop the sidebar shows the files below the sessions; Settings ›
  General › File browser brings back the Sessions | Files tabs and returns,
  without remounting the file tree (its file search keeps its query).
- Unknown sessions and paths outside the fixture project are rejected.
- Sidebar sessions open in browser tabs (`session-navigation.mjs`, desktop
  Chromium, one context so tabs share storage): a plain click and Enter
  select in place without a page load; Ctrl+click, middle-click and the row
  menu's Open in new tab (right-click, ⋯, T; just before Delete) open the clicked row's session in
  a new tab while the original keeps its own; both tabs keep their session
  through reloads; pinned and archived rows link the same way; nothing
  creates, copies or prompts a session; a missing session's link selects none
  in a fresh profile; a keyboard Fork puts focus on the copy row's link.
- Project groups offer Open in new tab (`project-navigation.mjs`, desktop
  and mobile Chromium): the current linked worktree, another project's root,
  and a pinned project without sessions open as fresh composers. Reload keeps
  that destination, not a remembered session. The original tab keeps its
  session, directory, draft, files and group expansion; + still opens in the
  same tab, and no session is created, copied, prompted or stopped. An
  unavailable directory shows the validation error instead of another session.
- The model picker, with a synthetic catalog: on a phone, a simulated keyboard
  (visual viewport shrink, pan, a late height with no event) keeps the same
  filter focused and the list in the visible viewport. Native phone keyboards
  still need real-device verification.
- Settings › Models drags a custom provider's models within it (never into
  another provider) and moves them with Alt+↑/↓, keeps the moved row focused,
  keeps the selected model open and its row mounted while it is edited, sorts
  shown names once with A–Z, appends later additions, and saves only the changed array order
  while preserving rename tracking (`model-order.mjs`, desktop and phone widths,
  mocked config routes).
- `/compact` leaves the composer focused and accepts the next draft while its
  POST is pending, on desktop and phone widths. The compaction response is mocked;
  no model is called (`composer-focus.mjs`).
- A local extension checks dialog keyboard navigation, Esc cancellation,
  collapse/expand draft preservation, countdown display, server-side expiry,
  and that `setEditorText` replaces the composer's draft while `pasteToEditor`
  inserts at the caret.
- The production assistant header keeps its height and numeric columns when streaming metrics appear, update and disappear. Static component renders cover digit boundaries with proportional and monospace fonts, without a live model. Run this check alone with `node e2e/streaming-metrics.mjs` (1280, 390 and 320px).

Model prompts, live model streaming, and agent execution are outside this suite.
Failures save a screenshot, Playwright trace, and server log under
`test-results/e2e/`; CI uploads that directory. Open a trace with
`npx playwright show-trace test-results/e2e/trace.zip`.

## HTTP/2 connection-pool regression (manual)

`http-connection-pool.mjs` checks the transport mechanism behind
[Serving Pi Web over HTTP/2](../docs/http2.md), not the Pi Web application.
It is deliberately separate from `npm run test:e2e` and CI: it needs an
existing Caddy binary, OpenSSL and Playwright Chromium. It installs nothing,
starts no Pi session, and makes no model requests.

With the checkout's dependencies and Chromium already available, download
Caddy from its [official releases](https://github.com/caddyserver/caddy/releases)
and verify the release digest before running it. A binary unpacked into a
temporary directory is enough; no system service or root access is needed.
The checked version for this script is Caddy **2.11.9**.

```sh
E2E_CADDY_BIN=/absolute/path/to/caddy node e2e/http-connection-pool.mjs
```

The script starts a synthetic HTTP/1.1 backend, then tests these cases in
separate browser contexts (the eight-page case shares one context):

- HTTP and HTTPS/HTTP1 negative controls: six EventSources keep a GET from
  reaching the backend for 800 ms; closing one lets the request complete.
- Caddy HTTP/2: one page with 12 EventSources and eight pages with 16 total.
  Each case makes 20 measured GET/POST requests after warming the pages.
  Every request must reach the backend exactly once, echo the right body,
  and report the actual browser protocol `h2`. Warm local p95 must be below
  500 ms and maximum below 2 s; a request is aborted at 5 s.
- A slow, unread HTTP/2 response must backpressure its upstream before the
  fixture's 16 MiB cap. Peer requests on the same connection must succeed
  both before and after cancelling the slow response, without reconnecting.
- Cancelling one stream or closing a page must release its upstream
  subscriptions without disconnecting the other streams. An idle keep-alive
  socket is not an active subscription, so the script does not require every
  socket to disappear or exactly one physical frontend connection.

JSON output records versions, observed browser connection counts, samples and
checks. Only the final `phase: "pass"` follows successful cleanup. The 120 s
hard deadline fails the run and kills its test processes; a failed check or
cleanup exits nonzero. There are no request replays to recover a failed test.
Caddy startup probes alone retry connection refusal or its transient
certificate-not-ready TLS alert, within a 10 s deadline and without bypassing
certificate validation.

### Isolation and evidence limits

All listeners use `127.0.0.1` and random high ports. Caddy has no admin or HTTP
redirect listener, uses only its internal CA, and has `skip_install_trust`:
its CA and configuration live in a temporary HOME/XDG directory, removed at
exit. A port race is a failure, never a reason to connect to another instance.
No system/browser trust store is changed. The browser's certificate exception
is limited to these disposable contexts; Node probes validate the temporary
CA and hostname normally. **This does not test ordinary browser certificate
trust or installing a CA.** HTTP/3 is disabled to make the HTTP/2 comparison
unambiguous.

Browser requests are restricted to the fixture origin and background browser
networking is disabled. For a hard network boundary, run in a disposable
container/network namespace with only loopback and no external route. The
script itself does not create that OS-level boundary. The recorded Linux run
used an unprivileged user/network/PID namespace; macOS, Windows and native
Safari/iOS have not been exercised.

The timings are local mechanism observations, not production latency promises.
This fixture does not replace a real-app proxy check: browser login and
Secure/HttpOnly cookies, Host/Origin rejection, agent reconnect snapshots,
terminal offset replay, file-watch revalidation, and `npm run dev` HMR need
separate checks against the relevant Pi Web version. A published `next start`
artifact and a development checkout are different evidence; do not build over
an active dev checkout or substitute an older installed version.
