# MCP & Plugin Setup Guide — from scratch

Two separate things need setup, and they don't share state: (1) authorizing connectors here in Cowork, and (2) wiring the equivalent tools into Claude Code in VS Code, which is where the agent loop actually runs. Do (2) even if you skip (1) — Cowork access doesn't carry over.

## Part 1 — Authorize connectors in Cowork (only affects this chat)

1. Go to claude.ai → Settings → Connectors (sometimes shown as "Capabilities" or "Integrations" depending on your plan).
2. For each plugin you actually want live here (Figma, GitHub, Notion, Slack, Linear, etc. — see `PLUGIN_INTEGRATION.md` for which ones matter), click **Connect** and complete the OAuth popup.
3. Come back to a Cowork chat — the tools become callable once authorized.

This does nothing for VS Code. Skip to Part 2 for the actual dev loop.

## Part 2 — Wire tools into Claude Code (VS Code) — this is what matters for the agents

All of this happens in a terminal, from the `PhotoSphere AI` project folder, with the Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`).

### A. GitHub (real branches + PRs for the Developer Agent)

Two ways — pick one:

**OAuth login (recommended, no token to copy/paste):**
```bash
claude mcp add --transport http github https://api.githubcopilot.com/mcp/
```
Then open Claude Code and run `/mcp` — it opens a browser login for GitHub. Approve it there.

**Personal access token (if you'd rather not do the browser flow):**
Generate a token yourself at github.com → Settings → Developer settings → Personal access tokens, then:
```bash
claude mcp add -s user --transport http github https://api.githubcopilot.com/mcp -H "Authorization: Bearer <your-token>"
```

Verify either way with `claude mcp list` — you should see `github` listed as connected. Once it's there, tell me and I'll flip `agents/DEVELOPER.md` off "local-only" so it starts pushing branches and opening real PRs.

### B. Figma (Stage 2 of the Developer Agent's UI flow)

Correction from what I said earlier: Figma's Dev Mode MCP server (currently in beta) can actually **create and modify** frames, components, variables, and auto-layout — not just read existing files. So the "SVG first, then Figma" workflow is genuinely buildable, not just aspirational. Setup is local (via the Figma desktop app), separate from the Cowork Figma connector:

1. Open the Figma desktop app, update to the latest version.
2. Open or create a design file.
3. Toggle **Dev Mode** (⇧D or the toggle in the bottom toolbar).
4. In the Inspect panel, find the MCP server section and click **Enable desktop MCP server**. It starts running locally at `http://127.0.0.1:3845/mcp`.
5. In your terminal:
   ```bash
   claude mcp add --transport http figma http://127.0.0.1:3845/mcp
   ```
6. In Claude Code, confirm it's live by asking it to use Figma, or typing `#get_design_context` in chat.

Note this only works while the Figma desktop app is open with that file's MCP server enabled — it's not an always-on cloud service.

### C. Skill bundles (write-spec, sprint-planning, design-handoff, testing-strategy, standup, etc.)

These are plugin-bundled skills, not live connectors — installed through Claude Code's plugin manager, not `claude mcp add`.

1. In Claude Code, run `/plugin` to open the plugin manager (Discover tab browses everything available). The official Anthropic marketplace is registered by default; for others, register first: `/plugin marketplace add <owner>/<repo>` (e.g. `anthropics/claude-plugins-official`).
2. Install what you need: `/plugin install <plugin-name>` (use the Discover tab if you're not sure of exact names — browse by category to match what you saw in Cowork: design, product-management, engineering, data).
3. Pick a scope when prompted — **project** scope (`.claude/settings.json`) is right for this repo since it's meant to be shared by whoever works on it, not just you personally.
4. Reload/restart the Claude Code session. The planner/developer/tester subagents can now invoke those skills directly.

### D. Notion / Slack / Linear / others (optional, only if you decided to use them)

Same pattern as GitHub: check that provider's own MCP docs for their server URL, then:
```bash
claude mcp add --transport http <name> <their-mcp-url>
```
followed by `/mcp` to run the OAuth login. Only bother with the ones `PLUGIN_INTEGRATION.md` flags as actually wired into the loop — most of the rest are marked "not needed yet."

## Quick reference

| Command | What it does |
|---|---|
| `claude mcp add --transport http <name> <url>` | Register a remote MCP server |
| `claude mcp add -s user ... -H "Authorization: Bearer <token>"` | Register with a token instead of OAuth |
| `claude mcp list` / `claude mcp get <name>` / `claude mcp remove <name>` | Manage registered servers |
| `/mcp` (inside Claude Code) | Run the OAuth login flow for a registered server |
| `/plugin` | Open the plugin manager UI |
| `/plugin marketplace add <owner>/<repo>` | Register a plugin catalog |
| `/plugin install <name>` | Install a specific plugin/skill bundle |

Sources: [Claude Code MCP docs](https://code.claude.com/docs/en/mcp), [Claude Code plugin marketplace docs](https://code.claude.com/docs/en/discover-plugins), [GitHub MCP server install guide](https://github.com/github/github-mcp-server/blob/main/docs/installation-guides/install-claude.md), [Figma Dev Mode MCP server guide](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server), [Figma MCP local server setup](https://developers.figma.com/docs/figma-mcp-server/local-server-installation/)
