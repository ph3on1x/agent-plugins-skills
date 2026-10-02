# Browser Automation Reference

Complete reference for cmux browser automation commands. All commands follow the pattern:
`cmux browser surface:N <action> [args]`

## Opening & Navigation

```bash
# Open browser (returns surface:N)
cmux browser open https://example.com --json

# Navigate
cmux browser surface:7 goto https://google.com
cmux browser surface:7 back
cmux browser surface:7 forward
cmux browser surface:7 reload

# Get current state
cmux browser surface:7 get url
cmux browser surface:7 get title
```

## Snapshot & Element Refs

**ALWAYS use `--interactive` to get element refs:**

```bash
cmux browser surface:7 snapshot --interactive

# Additional snapshot options
cmux browser surface:7 snapshot --interactive --compact          # Compact output
cmux browser surface:7 snapshot --interactive --max-depth 5      # Limit DOM depth
cmux browser surface:7 snapshot --interactive --selector "#main" # Scope to element
cmux browser surface:7 snapshot --interactive --cursor            # Include cursor position
```

Returns elements with `[ref=eN]` markers:
```
heading "Welcome" [ref=e1]
button "Submit" [ref=e2]
textbox [ref=e3]
link "Learn more" [ref=e4]
```

**Use refs for ALL interactions** — they survive minor DOM changes:

```bash
cmux browser surface:7 click e2           # Click button
cmux browser surface:7 dblclick e5        # Double-click
cmux browser surface:7 hover e3           # Hover over element
cmux browser surface:7 focus e3           # Focus element
```

## Form Interaction

```bash
cmux browser surface:7 fill e3 "hello"          # Fill input (empty string clears)
cmux browser surface:7 type e3 "world"          # Type text (appends)
cmux browser surface:7 select e7 "option-val"   # Select dropdown option
cmux browser surface:7 check e8               # Check checkbox
cmux browser surface:7 uncheck e8             # Uncheck checkbox
```

## Keyboard & Scrolling

```bash
cmux browser surface:7 press Enter                # Press key
cmux browser surface:7 keydown Shift
cmux browser surface:7 keyup Shift
cmux browser surface:7 scroll --dy 500           # Scroll down 500px
cmux browser surface:7 scroll --selector "#list" --dy 200  # Scroll within element
```

## Waiting & Verification

```bash
# Wait for conditions
cmux browser surface:7 wait --selector "#loaded" --timeout-ms 10000
cmux browser surface:7 wait --text "Success" --timeout-ms 5000
cmux browser surface:7 wait --url-contains "/dashboard"
cmux browser surface:7 wait --load-state complete --timeout-ms 15000
cmux browser surface:7 wait --function "document.readyState === 'complete'"

# Post-action verification
cmux browser surface:7 click e2 --snapshot-after --json    # Get fresh refs after click
```

## Finding Elements

```bash
cmux browser surface:7 find role button             # Find by ARIA role
cmux browser surface:7 find role button --name "Submit" --exact  # Exact match
cmux browser surface:7 find text "Submit"        # Find by visible text
cmux browser surface:7 find label "Email"        # Find by form label
cmux browser surface:7 find placeholder "Search" # Find by placeholder
cmux browser surface:7 find testid "submit-btn"  # Find by data-testid
cmux browser surface:7 find first               # First matching element
cmux browser surface:7 find last                # Last matching element
cmux browser surface:7 find nth 3               # Nth matching element
```

## Getting Page Data

```bash
cmux browser surface:7 get text e3              # Get element text
cmux browser surface:7 get html e3              # Get element HTML
cmux browser surface:7 get value e3             # Get input value
cmux browser surface:7 get attr e3 "href"       # Get attribute
cmux browser surface:7 get count "button"       # Count matching elements
cmux browser surface:7 get box e3               # Get bounding box
cmux browser surface:7 get styles e3            # Get computed styles
```

## JavaScript Evaluation

```bash
cmux browser surface:7 eval 'document.querySelector("h1").innerText'
cmux browser surface:7 eval 'window.location.href'
cmux browser surface:7 eval 'Array.from(document.querySelectorAll("a")).map(a => a.href)'
```

## Session & State

```bash
# Cookies
cmux browser surface:7 cookies get
cmux browser surface:7 cookies set --name "session" --value "abc123"
cmux browser surface:7 cookies clear

# Storage
cmux browser surface:7 storage local get --key "user"
cmux browser surface:7 storage session set --key "token" --value "xyz"
cmux browser surface:7 storage local clear

# State persistence (for auth sessions)
cmux browser surface:7 state save ~/.browser-state/session1.json
cmux browser surface:7 state load ~/.browser-state/session1.json

# Browser tabs (within surface)
cmux browser surface:7 tab list
cmux browser surface:7 tab new
cmux browser surface:7 tab switch 2
cmux browser surface:7 tab close 2
```

## Element State Checks

```bash
cmux browser surface:7 is visible e3           # Check if element is visible
cmux browser surface:7 is enabled e3           # Check if element is enabled
cmux browser surface:7 is checked e8           # Check if checkbox is checked
```

## Iframes

```bash
cmux browser surface:7 frame "#iframe-id"      # Switch to iframe context
cmux browser surface:7 frame main              # Switch back to main frame
```

## Dialogs

```bash
cmux browser surface:7 dialog accept           # Accept alert/confirm
cmux browser surface:7 dialog dismiss          # Dismiss dialog
cmux browser surface:7 dialog accept "input"   # Accept prompt with text
```

## Script & Style Injection

```bash
# Inject JavaScript that runs on every page load
cmux browser surface:7 addinitscript 'console.log("injected")'

# Inject CSS
cmux browser surface:7 addstyle 'body { background: #f0f0f0; }'
```

## Diagnostics

```bash
cmux browser surface:7 console list        # View console messages
cmux browser surface:7 console clear
cmux browser surface:7 errors list          # View JavaScript errors
cmux browser surface:7 errors clear
cmux browser surface:7 highlight e3          # Visually highlight element
cmux browser surface:7 screenshot            # Capture screenshot
cmux browser surface:7 download wait --timeout-ms 10000  # Wait for download
```

## WKWebView Limitations

These return `not_supported` — use alternatives:
- `viewport.set` — Cannot emulate viewports
- `geolocation.set` — Cannot fake location
- `offline.set` — Cannot simulate offline
- `trace.start|stop` — No tracing
- `network.route|unroute|requests` — No request interception
- `screencast.start|stop` — No video recording
- `input_mouse|input_keyboard|input_touch` — Use high-level commands (`click`, `fill`, `type`) instead
