# NovaCourt V2

A fresh Electron, React, TypeScript, and Vite desktop application for a three-seat conversation.

## Current milestone

M0 through M4-V2 Phase A are implemented. The app opens directly to Karl, Astra, and Nova panels. Astra loads the real ChatGPT website inside a native `WebContentsView` using a dedicated `persist:chatgpt` Electron partition. Sign in manually in that panel; NovaCourt does not read account state or conversations. Karl's composer saves local notes. Nova offers chat-only discussion through a local OpenCode server and two separately controlled interactive terminals. Dividers resize the columns, and widths persist locally.

The offline Astra fixture is retained for automated layout tests. Nova Chat messages are sent only when Karl presses Send in that view. There is no automatic Astra relay; terminal activity starts only on Karl's direct action.

## Portraits

Karl, Astra, and Nova each have a seat in the courtroom. By default a seat shows a coloured initial, because NovaCourt will not generate a likeness of a real person. The **Portraits** page lets Karl upload approved artwork for each seat.

Upload accepts PNG, JPG, and WebP up to 4 MB and 4096px per side. The format is decided by reading the file's magic bytes in the main process, never by the extension or by a MIME type the renderer claims, so a renamed script cannot be written into the portraits folder. Files are written to `%APPDATA%\NovaCourt-V2\portraits\` with a generated name and are never stored in the repository; the renderer never learns a filesystem path and receives images as data URLs. An index entry is accepted only if the referenced file exists at its recorded size, and files the index does not claim are pruned on launch.

A crop is chosen before saving: zoom from 1× to 3× and drag the image to set the focal point. The crop is stored as presentation metadata, so an image can be re-framed later without uploading it again. Replace, reset crop, and remove are all available, and every avatar updates immediately without a restart. A malformed index degrades to initials rather than failing to launch.

Phase C approval states and automated ChatGPT forwarding are **not** implemented. See the milestone proposal: automated forwarding is gated on a recorded Terms-of-Service acceptance that does not exist yet.

## Embedded terminals

Nova's three tabs are **OpenCode Terminal**, **PowerShell**, and **Nova Chat**. Selecting a terminal tab does not start a process. Click **Start** to launch it in the selected repository. The OpenCode tab runs the installed official CLI with its documented `--mini` interactive interface, which renders in the narrow right-hand panel. It does not use `--auto`. PowerShell starts an ordinary interactive shell. Both use Windows ConPTY through `node-pty` and xterm.js, including keyboard input, ANSI output, scrollback, and resize handling. Only one terminal process runs at a time; switching tabs leaves it running. Stop and Restart ask for confirmation before interrupting an active process. Closing NovaCourt stops its terminal process.

**Terminal access is higher trust than Nova Chat.** A terminal command or OpenCode tool can use Karl's local account permissions; Nova Chat's deny-all tool policy does not constrain it. Choose the model inside OpenCode before sending a prompt, since configured providers may charge. Terminal input comes only from the local terminal control; ChatGPT's native web view and Nova Chat responses have no terminal-write bridge. The terminal output stays in memory for the current app session and is not saved by NovaCourt. On Windows, `node-pty` uses ConPTY. If an Electron update causes a native module load error, run `npm run rebuild:native` with the required Windows C++ build tools installed.

The earlier `opencode/ling-3.1-flash-free` HTTP request received a provider 403. On 2026-10-11, a direct official CLI `opencode run --model opencode/ling-3.1-flash-free --agent plan` test with a short no-tools prompt returned the requested token. That verifies this free model worked through the CLI at that time; it does not guarantee future availability or apply to other models.

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

The default `npm test` also launches an isolated Electron instance with the offline Astra fixture and verifies real PowerShell and OpenCode ConPTY sessions. It writes renderer screenshots to `test-results/m31-powershell-terminal-renderer.png` and `test-results/m31-opencode-terminal-renderer.png`. Those renderer captures omit the native Astra view; the separate fixture and live ChatGPT tests verify that view's bounds and lifecycle.

For a real interactive OpenCode CLI exchange including a tool permission prompt, run `$env:NC_V2_REAL_TERMINAL_SMOKE='1'; npx playwright test tests/live-terminal.spec.ts --workers=1`. It types into the real CLI, switches models, and sends a prompt that triggers a `bash` tool call. It uses your configured provider and may incur charges, so it is skipped by default.
