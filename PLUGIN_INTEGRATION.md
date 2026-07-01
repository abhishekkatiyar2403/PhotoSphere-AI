# Plugin & Skill Integration Map

You connected a batch of plugins (design, product-management, engineering, data) in Cowork. This maps each one to where it fits in the Master/Planner/Developer/Tester loop — and is honest about what's actually usable today versus what needs setup first.

## Two things that don't carry over automatically

**1. Authorization.** Most of these still need OAuth before any tool call works: GitHub, Notion, Slack, Linear, Atlassian, Datadog, ClickUp, Monday, Fireflies, Intercom, Pendo, Amplitude, Hex all showed as "needs authentication" when checked. Authorize the ones you actually want, from claude.ai's connector settings (for claude.ai-managed connectors) — do this once per connector.

**2. Cowork ≠ Claude Code.** You chose VS Code + the Claude Code extension as where this agent loop actually runs day to day. Connectors authorized here, in this Cowork chat, do not automatically become available inside Claude Code in VS Code — that's a separate surface with its own MCP configuration. To use any of these from the agents defined in `.claude/agents/`, you'll need to add the equivalent MCP server inside Claude Code itself (via `claude mcp add <name> ...` or the `/mcp` command in an interactive Claude Code session), and authorize it there too. Skills (the SKILL.md-based ones, bundled in plugins) work the same way — install the same plugin/marketplace in Claude Code (`/plugin marketplace add`, `/plugin install`) so those subagents can actually invoke them.

Every agent role file already says what to do if a plugin/skill it wants isn't there: fall back to the plain-markdown version of that step, don't block. So none of this is required to keep building — it's upside once wired in.

## Mapped to the loop now

| Plugin / skill | Agent | Where it plugs in | Status |
|---|---|---|---|
| `product-management:write-spec`, `sprint-planning`, `roadmap-update` | **Planner** | Core toolkit — these are *why* the Planner role exists. Falls back to `specs/TEMPLATE.md` if not installed in Claude Code. | Needs plugin added to Claude Code |
| `design:design-critique`, `accessibility-review`, `ux-copy`, `design-system` | **Developer** | Once an SVG option is picked, run these to critique it before committing, check contrast/touch targets, and write microcopy (error states, empty states — already in the roadmap's Week 11 checklist). UI design stays SVG-only — no Figma step. | Needs plugin added to Claude Code |
| `engineering:github` (MCP) | **Developer** | Real branch pushes + PRs, replacing the local-only MR drafts in `reports/mr-drafts/`. You chose to stay local-only for now — this is what to flip on later. | Deferred by choice |
| `engineering:architecture`, `system-design` | **Developer** | Structural decisions (e.g. Prisma schema choices, queue design) — write an ADR instead of just deciding silently. | Needs plugin added to Claude Code |
| `engineering:testing-strategy` | **Tester** | Design the regression suite structure up front instead of ad hoc Playwright specs. | Needs plugin added to Claude Code |
| `engineering:code-review` | **Developer** | Self-review diffs before committing, or as an extra step after Tester's pass. | Needs plugin added to Claude Code |
| `engineering:standup` | **Master** | Format the plain-language report to Abhishek after each `/orchestrate` cycle. | Needs plugin added to Claude Code |
| `engineering:documentation` | **Developer** | README/API docs as features ship. | Needs plugin added to Claude Code |

## Available, not wired into the automated loop (use ad hoc, in Cowork, when useful)

- `engineering:debug`, `tech-debt`, `deploy-checklist`, `incident-response` — reach for these once there's a running/deployed system to debug or ship, not during initial scaffolding.
- `product-management:product-brainstorming`, `brainstorm`, `competitive-brief`, `stakeholder-update`, `synthesize-research`, `metrics-review` — useful for strategy conversations with Abhishek directly (here in Cowork), not part of the automated test→fix cycle.
- `design:user-research`, `research-synthesis` — feed into Planner's specs once there's real user feedback (post-launch).
- `engineering:notion` — optional: mirror `agents/STATUS.md` or `specs/` to a Notion page for a nicer read view. Markdown stays the source of truth either way.
- `engineering:slack` — optional: have Master post its plain-language summary to a Slack channel/DM in addition to (not instead of) replying in chat.
- `engineering:linear`, `product-management:clickup`, `monday`, `atlassian` — pick at most one if you want a real PM board mirroring the sprint/bug state. Mirroring to more than one creates sync drift; `STATUS.md` remains the source of truth regardless.
- `engineering:datadog`, `pagerduty` — Phase 2+, once something is actually deployed and needs monitoring.
- `data:amplitude`, `bigquery`, `hex`, `definite`, `product-management:pendo`, `similarweb` — Phase 2+ product analytics, once there are real users to measure.
- `product-management:fireflies`, `intercom`, `productivity:gmail`, `google calendar` — not obviously relevant to this build loop; skip unless a specific use comes up.

## Recommended next step

The Planner skills (write-spec/sprint-planning) are the highest-leverage row above given what you asked for. `MCP_SETUP_GUIDE.md` has the exact commands. Wire those into Claude Code first, run one `/orchestrate` cycle, and see how much it actually changes before wiring in the rest.
