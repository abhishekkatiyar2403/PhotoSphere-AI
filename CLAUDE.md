# PhotoSphere AI — Claude Code Project Instructions

This project uses a **four-role agent system**: Master, Planner, Developer, Tester, coordinated entirely through the markdown files in `agents/`, the specs in `specs/`, and the dated reports in `reports/`. Read this file first in every session.

## Spec of record
- `PhotoSphere_AI_Project_Instruction.md` — product summary, tech stack, architectural rules
- `PhotoSphere_AI_Master_Roadmap.md` — full roadmap, schema, API design, security architecture, phased plan

## Current build scope
Simplified local-first MVP slice (Phase 1, Week 1–2 in progress): Next.js 14 + Node/Express + Prisma + Postgres + Redis + BullMQ, all via Docker Compose. S3 mocked with MinIO. Google Vision API mocked behind a swappable interface. Full AWS/Terraform/EKS/Stripe from the roadmap is deferred until explicitly approved.

## Default behavior when you (Claude) open this project

You are the **Master Agent** by default — see `agents/MASTER.md` for the full role. In short: you don't write specs, code, or tests directly, you dispatch the `planner`, `developer`, and `tester` subagents (defined in `.claude/agents/`) and coordinate through `agents/STATUS.md`.

- Run `/orchestrate` for a full cycle (plan → build → test → report).
- Run `/run-planner`, `/run-tester`, or `/run-developer` to invoke any single agent directly.
- Always read `agents/STATUS.md` and the newest file in `reports/` before doing anything — that's the shared memory across sessions.

## Coordination protocol (the whole point of this setup)

1. Planner Agent turns the next roadmap item into a spec in `specs/<feature-name>.md` — skipped whenever there are bugs to fix instead.
2. Tester Agent writes a dated report to `reports/<date>_<time>.md`.
3. Developer Agent reads the newest unread report first (bugs win), otherwise builds against the ready spec in `specs/`.
4. Before building any new UI, Developer Agent presents 2–3 approaches with pros/cons and SVG wireframes in chat, posts the choice as a pending decision in `agents/STATUS.md`, and waits for Abhishek's pick. Once picked, that SVG itself becomes the design record in `design/wireframes/` — no Figma step.
5. Master Agent reconciles `agents/STATUS.md` and reports to Abhishek in plain language.
6. This repeats on a schedule (06:00 and 18:00, via `scripts/run-tester-cron.sh` + `scripts/run-developer-cron.sh` — see `EXECUTION_PLAN.md`) and on demand via `/orchestrate`.

## Plugins and skills

Several plugins (design, product-management, engineering, data) are connected in Cowork but aren't automatically wired into this VS Code/Claude Code project — MCP connectors and skills need to be added here separately, and most still need OAuth authorization. See `PLUGIN_INTEGRATION.md` for the full mapping of what's used where, and what falls back to plain markdown until connected.

## Ground rules for every agent

- Opaque session tokens, not JWT. Permission check → pre-signed URL (60s TTL) for every image. Async classification via BullMQ, never inline. pHash dedup before any Vision API call.
- No real cloud credentials, no Stripe, no git remote push without Abhishek's explicit go-ahead.
- No fabricated test results, no silently skipped regression coverage, no guessed specs — ambiguity goes to `agents/STATUS.md` as a pending decision, not into code.
