# chrome-bridge — Install Guide for AI Agents

You are an AI agent setting up chrome-bridge for the user. Done = `chrome-bridge doctor` reports every check `ok` (or `na`). Never use `sudo`; you cannot install the extension yourself (Step 2 is the user's job).

## 1. Install the CLI and skill

Run the install command for the user's OS.

### macOS / Linux

```bash
curl -fsSL https://github.com/zhaocore/chrome-bridge/raw/refs/heads/master/install.sh | bash
```

### Windows (PowerShell)

```powershell
irm https://github.com/zhaocore/chrome-bridge/raw/refs/heads/master/install.ps1 | iex
```

The installer will:

1. Detect OS/arch and download the binary to `~/.chrome-bridge/bin/chrome-bridge`
2. Start the daemon
3. Install skills to detected AI agent runtimes

## 2. Open the extension install page

If `extension connected` is `FAIL` (`0 browsers connected`), the user likely has not installed or enabled the browser extension yet. Open the [Chrome Web Store install page](https://chromewebstore.google.com/detail/chromebridge/banojplagbjebdnnmklagfagbepelcha) in the user's browser, then tell the user:

> Install ChromeBridge from the [Chrome Web Store](https://chromewebstore.google.com/detail/chromebridge/banojplagbjebdnnmklagfagbepelcha), open the popup, and wait until it turns green. Reply when done.

If opening the page fails, give the user the same link. Then run `chrome-bridge doctor` once more. All `ok`/`na` → tell the user it's ready.
