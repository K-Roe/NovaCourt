# NovaCourt V2 - Astra Auto-Paste Bug Reproduction Instructions

## Current Status
- Diagnostics added to `astra:paste` handler
- Focus delay increased from 50ms to 500ms
- Click attempt at center of view bounds added
- UI messaging updated: "Paste events dispatched" (not "Text pasted into editor")

## How to Test with Real ChatGPT

### Prerequisites
1. Ensure you're signed in to ChatGPT at https://chatgpt.com/
2. The app uses persistent partition `persist:chatgpt` - cookies persist across restarts

### Test Steps

1. **Launch with real ChatGPT (not fixture):**
   ```powershell
   $env:NC_V2_ASTRA_FIXTURE = '0'
   npm start
   ```
   Or if using dev server:
   ```powershell
   $env:NC_V2_ASTRA_FIXTURE = '0'
   $env:NC_V2_DEV_URL = 'http://localhost:5173'
   npm run dev
   ```

2. **Wait for Astra panel to load:**
   - Status should show "WEBSITE OPEN" (not "SIGN-IN PAGE")
   - If "SIGN-IN PAGE", sign in manually in the Astra panel

3. **Open Developer Tools to see diagnostics:**
   - In the main NovaCourt window: Ctrl+Shift+I -> Console tab
   - Or right-click Astra panel -> Inspect (but this opens DevTools for the WebContentsView)

4. **Test Case A: ChatGPT editor manually focused before Send**
   - Click inside the ChatGPT message editor (the text input area at bottom)
   - In NovaCourt composer: select "TO: Astra", type a test message
   - Press Send
   - Check Console for `[NovaCourt] Astra paste diagnostics:`
   - Observe: Does text appear in ChatGPT editor?

5. **Test Case B: ChatGPT webpage visible but editor NOT focused**
   - Click somewhere in Astra panel OUTSIDE the message editor (e.g., on a previous message)
   - In NovaCourt composer: select "TO: Astra", type a test message
   - Press Send
   - Check diagnostics and observe result

6. **Test Case C: Switch from Nova panel to Astra then Send**
   - Click on Nova panel (right panel)
   - Click back on Astra panel (middle)
   - In NovaCourt composer: select "TO: Astra", type a test message
   - Press Send
   - Check diagnostics and observe result

7. **Test Case D: Both recipients selected**
   - In NovaCourt composer: select "TO: Both", type a test message
   - Press Send
   - Check diagnostics for Astra paste

8. **Test Case E: Multiline message**
   - In NovaCourt composer: select "TO: Astra", type a multiline message (Shift+Enter for newlines)
   - Press Send
   - Check if multiline pastes correctly

## What to Report Back

For each test case, please report:

1. **Did text appear in ChatGPT editor?** (YES/NO/PARTIAL)
2. **Console diagnostics output** (copy the `[NovaCourt] Astra paste diagnostics:` object)
3. **Astra status at time of test** (WEBSITE OPEN / SIGN-IN PAGE / etc.)
4. **Was main window focused?** (check diagnostics.mainWindowFocused)
5. **Was WebContents focused after click?** (check diagnostics.webContentsFocusedAfterClick)

## Expected Diagnostics Structure
```javascript
{
  url: "https://chatgpt.com/...",
  isChatPage: true,
  webContentsFocusedBefore: false,
  mainWindowFocused: true,
  viewVisible: true,
  viewBounds: { x: ..., y: ..., width: ..., height: ... },
  clipboardTextLength: 42,
  webContentsFocusedAfter: true,
  focusCallResult: undefined,  // Electron focus() returns void
  webContentsFocusedAfterWait: true,
  clickAttempted: true,
  clickCoordinates: { x: 200, y: 150 },
  webContentsFocusedAfterClick: true,
  pasteEventsDispatched: true
}
```

## Key Questions to Answer

1. **Does the click at center help focus the editor?**
   - Compare `webContentsFocusedAfterWait` vs `webContentsFocusedAfterClick`

2. **Does the paste work when editor is pre-focused?**
   - Test Case A should work if focus is the only issue

3. **Does the paste work when editor is NOT pre-focused?**
   - Test Case B is the real-world scenario

4. **Are there any Electron errors in the main process console?**

## Notes
- The clipboard ALWAYS gets the message text (via `prepareForAstra`)
- Auto-paste is a convenience; manual paste (Ctrl+V) always works as fallback
- Diagnostics are only logged in development mode (NODE_ENV=development)