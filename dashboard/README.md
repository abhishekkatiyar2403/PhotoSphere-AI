# PhotoSphere AI — Local Insights Dashboard

A local, **uncommitted** (gitignored) GUI for glancing at project state and queuing future features
for your next `/orchestrate` cycle. Zero dependencies — Node built-ins only.

## Run

```bash
# from the project root
node dashboard/server.js
# then open http://localhost:4321
```

Optional: `DASHBOARD_PORT=5000 node dashboard/server.js`

## What it shows

Reads the four-agent coordination files **live** every time you refresh:

- `agents/STATUS.md` → current phase, sprint goal, ready spec, open bugs, pending decisions
- `reports/*.md` → tester pass-rate trend across dated regression runs
- `specs/*.md` → shipped specs
- `PhotoSphere_AI_Master_Roadmap.md` → Phase 1 checklist progress

## Suggested features → queue → orchestrate

The **Suggested Features** section lists curated, roadmap-grounded, production/enterprise-grade
next moves (see `suggestions.json`). ★ = high-impact tier. Click **Queue for next /orchestrate**
and the server appends a structured block to `dashboard/FEATURE_QUEUE.md`.

The Master and Planner agents read `dashboard/FEATURE_QUEUE.md` at the start of every `/orchestrate`
cycle: queued features are scoped **after** any open bugs but **before** the default next roadmap
item. (Wired via `CLAUDE.md`, `agents/MASTER.md`, `agents/PLANNER.md`, and
`.claude/commands/orchestrate.md`.)

Edit `suggestions.json` to add or reword suggestions — no code change needed.

## Why it's separate / not committed

This is a personal cockpit, not part of the app. The whole `dashboard/` folder is in `.gitignore`,
so nothing here (including `FEATURE_QUEUE.md`) is committed. The agents still read the queue from
local disk regardless of git tracking, so click-to-queue works while keeping your repo clean.
