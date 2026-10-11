# NovaCourt V2

A fresh Electron, React, TypeScript, and Vite desktop application for a three-seat conversation.

## Current milestone

M0 through M2 are implemented. The app opens directly to Karl, Astra, and Nova panels. Astra loads the real ChatGPT website inside a native `WebContentsView` using a dedicated `persist:chatgpt` Electron partition. Sign in manually in that panel; NovaCourt does not read account state or conversations. Karl's composer saves local notes. Nova shows its honest disconnected state. Dividers resize the columns, and widths persist locally.

The offline Astra fixture is retained for automated layout tests. OpenCode integration and message delivery are future milestones. No message currently leaves the app.

## Run

```powershell
npm install
npm run build
npm start
```

For Vite development, use `npm run dev`. Run typecheck, production build, and the real Electron layout test with `npm test`.

On first launch, use ChatGPT's own controls in Astra's panel to accept or reject cookies and sign in. NovaCourt does not store a password. The Astra badge reports website loading and navigation errors; `WEBSITE OPEN` means the page loaded, not that an account is signed in. The reload button retries `https://chatgpt.com/`.

The test writes screenshots to `test-results/`, including `m2-offline-fixture-window.png` captured from the desktop so the native Astra view is visible. Test data stays in isolated `test-results/user-*` directories; ordinary app data uses Electron's user data directory. Run with `NC_V2_ASTRA_FIXTURE=1` only when testing the offline layout fixture.

For an explicit live smoke test, run `$env:NC_V2_LIVE_SMOKE='1'; npx playwright test --workers=1`. It uses a separate test profile and checks website loading and partition persistence without signing in or reading website content.
