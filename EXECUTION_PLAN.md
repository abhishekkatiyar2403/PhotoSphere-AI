# PhotoSphere AI — Multi-Agent Execution Plan (VS Code + Claude Code extension)

This is the plan for running the Master/Developer/Tester agent loop you asked for, using the Claude extension in VS Code. Everything referenced below has already been scaffolded into this project folder.

## What was built just now

```
PhotoSphere AI/
├── CLAUDE.md                      ← auto-loaded by Claude Code, wires everything together
├── agents/
│   ├── MASTER.md                  ← Master Agent role + escalation rules
│   ├── DEVELOPER.md               ← Developer Agent role + engineering principles + loop
│   ├── TESTER.md                  ← Tester Agent role + loop
│   └── STATUS.md                  ← live shared state, single source of truth
├── reports/
│   ├── TEMPLATE.md                ← format every test report follows
│   └── mr-drafts/                 ← (created on first use) MR-ready diffs, pending GitHub
├── .claude/
│   ├── agents/
│   │   ├── developer.md           ← real Claude Code subagent definition
│   │   └── tester.md              ← real Claude Code subagent definition
│   └── commands/
│       ├── orchestrate.md         ← /orchestrate — full cycle
│       ├── run-tester.md          ← /run-tester — tester only
│       └── run-developer.md       ← /run-developer — developer only
├── scripts/
│   ├── run-tester-cron.sh         ← headless cron entry point (06:00/18:00)
│   └── run-developer-cron.sh
└── (git initialized locally, first commit made)
```

## How the coordination actually works

The MD files are the shared memory. Every agent invocation — whether it's you typing `/orchestrate` in VS Code, or a cron job firing at 6am with nobody watching — starts with **zero memory of anything before it**. The only continuity is what's written in `agents/STATUS.md` and the timestamped files in `reports/`. That's intentional and is the actual mechanism behind "the developer agent automatically picks up the new report" — there's no long-running process watching a folder; each run reads the files fresh, acts, and writes back.

Roles:
- **Master** — this is you talking to Claude Code in the main VS Code chat, or the headless session run by cron. It never writes app code directly. It dispatches Developer and Tester as subagents (via Claude Code's built-in Task tool) and owns `STATUS.md`.
- **Developer** — a real Claude Code subagent (`.claude/agents/developer.md`), scoped tools: Read/Write/Edit/Bash/Glob/Grep. Reads the latest report, fixes bugs by severity, builds the next sprint item, commits locally.
- **Tester** — a real Claude Code subagent (`.claude/agents/tester.md`), scoped tools: Read/Write/Bash/Glob/Grep (no Edit — it can't touch app code). Runs Playwright against your local dev server, writes a dated report.

## Two things I scoped differently than literally requested, and why

**1. "Google Chrome cloud extension" for regression testing → Playwright instead.**
Live browser-driving ("Claude in Chrome") is a Cowork-specific capability tied to this chat interface — it doesn't exist inside the VS Code extension. Inside VS Code, the Tester Agent will write and run **Playwright** specs against your local dev server. Functionally this covers the same ground for regression testing (navigate, click, assert, screenshot-on-failure) and is scriptable/repeatable, which a live-driven browser session isn't.

**2. No literal 24/7 background loop.**
Claude Code (VS Code extension or CLI) doesn't run as a standing daemon. The "always looping until the end goal" behavior is achieved by: (a) you running `/orchestrate` on demand inside VS Code, and (b) OS-level cron firing `claude -p` headlessly at 06:00 and 18:00 (scripts already written, setup below). Both paths converge on the same coordination files, so the effect is continuous even though no single process is running continuously.

## One-time setup (do this today)

1. **Install Claude Code CLI** if you haven't: `npm install -g @anthropic-ai/claude-code`, then `claude` once interactively to authenticate.
2. **Open this project folder in VS Code** with the Claude extension installed — it will auto-load `CLAUDE.md`.
3. **Docker Compose for local stack** — not created yet; first thing the Developer Agent will do when you kick off Week 1–2 (Postgres + Redis + MinIO). You'll need Docker Desktop running.
4. **Install Playwright** — the Tester Agent will do this itself on first `/run-tester` (`npm install -D @playwright/test && npx playwright install`), but you need Node.js installed locally.
5. **Wire up the cron schedule** (macOS):
   ```bash
   crontab -e
   # add these two lines (adjust the path to wherever this folder actually lives):
   0 6  * * * /Users/akatiyar/Claude/Projects/PhotoSphere\ AI/scripts/run-tester-cron.sh >> /Users/akatiyar/Claude/Projects/PhotoSphere\ AI/logs/tester.log 2>&1
   0 18 * * * /Users/akatiyar/Claude/Projects/PhotoSphere\ AI/scripts/run-tester-cron.sh >> /Users/akatiyar/Claude/Projects/PhotoSphere\ AI/logs/tester.log 2>&1
   ```
   Note: macOS cron requires granting Terminal/cron "Full Disk Access" in System Settings → Privacy & Security, and your **dev server must already be running** at those times (cron can't launch Docker Desktop + your app for you unless you extend the script to do so). If cron gives you trouble, `launchd` is the macOS-native alternative — tell me and I'll write the `.plist` instead.
   Also: `--dangerously-skip-permissions` in the cron scripts means those headless runs execute without asking you to approve each tool call. That's what makes 6am unattended runs possible, and it's scoped to what's in `.claude/agents/*.md` — but review that file's tool list before trusting it fully unattended.

## What happens today, step by step

1. You open VS Code, run `/orchestrate` (or just ask Claude to start Week 1–2).
2. Master reads `agents/STATUS.md` — current goal is "stand up the local MVP slice." No report exists yet, so it skips straight to dispatching Developer.
3. Developer Agent scaffolds the Next.js + Express + Prisma + Docker Compose skeleton, builds auth (per roadmap Week 1–2), commits locally, updates STATUS.md.
4. You run `docker compose up` and `npm run dev` yourself (agents don't manage your local processes for you).
5. Run `/run-tester` — first regression report gets generated.
6. From then on, `/orchestrate` (or the 6am/6pm cron) closes the loop: test → fix → report → repeat.
7. Whenever Developer Agent hits a new UI surface, it stops and shows you 2–3 options with pros/cons and an SVG wireframe for each, posts them to STATUS.md, and waits for your pick before building.

## Deferred until you say go

- **GitHub connection** — Developer Agent commits locally and writes MR-ready drafts to `reports/mr-drafts/`. The moment you connect a GitHub remote/token, those drafts become real `gh pr create` calls with almost no extra work.
- **Real AWS S3 / Google Vision API / Stripe / Terraform / EKS** — everything is mocked locally (MinIO for S3, a swappable classifier interface for Vision) until you hand over real credentials.

## Next decision point

Once the MVP skeleton exists and the first test report comes back, we'll know if the 06:00/18:00 cadence is actually useful yet (early on, you'll be iterating faster than twice a day) — worth revisiting after a few days.
