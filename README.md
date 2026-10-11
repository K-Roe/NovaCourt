# NovaCourt V2

A fresh Electron, React, TypeScript, and Vite desktop application for a three-seat conversation.

## Current milestone

M0 through M3 are implemented. The app opens directly to Karl, Astra, and Nova panels. Astra loads the real ChatGPT website inside a native `WebContentsView` using a dedicated `persist:chatgpt` Electron partition. Sign in manually in that panel; NovaCourt does not read account state or conversations. Karl's composer saves local notes. Nova connects to a local OpenCode server for chat-only discussion. Dividers resize the columns, and widths persist locally.

The offline Astra fixture is retained for automated layout tests. Nova messages are sent only when Karl presses Send in Nova's panel. There is no automatic Astra relay or executable agent mode.

## Run

```powershell
npm install
npm run build
npm start
```

For Vite development, use `npm run dev`. Run typecheck, production build, and the real Electron layout test with `npm test`.

On first launch, use ChatGPT's own controls in Astra's panel to accept or reject cookies and sign in. NovaCourt does not store a password. The Astra badge reports website loading and navigation errors; `WEBSITE OPEN` means the page loaded, not that an account is signed in. The reload button retries `https://chatgpt.com/`.

## Connect Nova

NovaCourt tries `http://127.0.0.1:4096` on launch. If a local OpenCode server is running there, Nova connects and verifies its version and session API. Otherwise, use **Start local server** in Nova's panel. The server uses the selected repository as its working directory and a deny-all OpenCode permission policy. To attach to a different loopback server, open the small Nova settings button and enter its endpoint. The OpenCode executable and repository workspace can be changed there too; choose an existing Git repository under your `repos` directory. The selected workspace and session are saved locally in Electron's user data. Switching workspaces clears the session selection.

Start a new session, select a listed free model, and send from Nova's composer. Existing sessions appear in the selector; sessions without verified tool denial are readable but cannot receive messages. All currently available tools are disabled in each prompt as an additional safeguard. Responses and tool or API errors come from the local OpenCode server. Stop sends OpenCode's session abort request. If delivery is uncertain after a connection error, check session history before retrying.

Only models advertised by the connected server as free are offered. Provider access, rate limits, privacy terms, and model availability are controlled by the provider. No paid model is selected or sent automatically. The local server API is limited to the configured loopback address, but any other local process with access to that server is outside NovaCourt's control.

The test writes screenshots to `test-results/`, including `m2-offline-fixture-window.png` captured from the desktop so the native Astra view is visible. Test data stays in isolated `test-results/user-*` directories; ordinary app data uses Electron's user data directory. Run with `NC_V2_ASTRA_FIXTURE=1` only when testing the offline layout fixture.

For an explicit ChatGPT smoke test, run `$env:NC_V2_LIVE_SMOKE='1'; npx playwright test tests/live-chatgpt.spec.ts --workers=1`. It uses a separate test profile and checks website loading and partition persistence without signing in or reading website content.

For a genuine OpenCode exchange on a known free model, run `$env:NC_V2_REAL_OPENCODE_SMOKE='1'; npx playwright test tests/live-opencode.spec.ts --workers=1`. This sends a short prompt through your configured local OpenCode server and uses an isolated Electron profile. It does not use your ChatGPT login. The test writes a desktop screenshot to `test-results/m3-live-three-column-window.png`.
