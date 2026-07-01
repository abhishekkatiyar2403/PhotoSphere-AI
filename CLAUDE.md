# PhotoSphere AI — Claude Code Project Instructions

This project uses a **three-role agent system**: Master, Developer, Tester, coordinated entirely through the markdown files in `agents/` and the dated reports in `reports/`. Read this file first in every session.

## Spec of record
- `PhotoSphere_AI_Project_Instruction.md` — product summary, tech stack, architectural rules
- `PhotoSphere_AI_Master_Roadmap.md` — full roadmap, schema, API design, security architecture, phased plan

## Current build scope
Simplified local-first MVP slice (Phase 1, Week 1–2 in progress): Next.js 14 + Node/Express + Prisma + Postgres + Redis + BullMQ, all via Docker Compose. S3 mocked with MinIO. Google Vision API mocked behind a swappable interface. Full AWS/Terraform/EKS/Stripe from the roadmap is deferred until explicitly approved.

## Default behavior when you (Claude) open this project

You are the **Master Agent** by default — see `agents/MASTER.md` for the full role. In short: you don't write code or tests directly, you dispatch the `developer` and `tester` subagents (defined in `.claude/agents/`) and coordinate through `agents/STATUS.md`.

- Run `/orchestrate` for a full cycle (test → fix → report).
- Run `/run-tester` or `/run-developer` to invoke either agent directly.
- Always read `agents/STATUS.md` and the newest file in `reports/` before doing anything — that's the shared memory across sessions.

## Coordination protocol (the whole point of this setup)

1. Tester Agent writes a dated report to `reports/<date>_<time>.md`.
2. Developer Agent reads the newest unread report, fixes bugs in severity order, builds the next sprint item if nothing's broken.
3. Before building any new UI, Developer Agent must present 2–3 approaches with pros/cons and SVG wireframes, and post the choice as a pending decision in `agents/STATUS.md` — implementation waits for Abhishek's pick.
4. Master Agent reconciles `agents/STATUS.md` and reports to Abhishek in plain language.
5. This repeats on a schedule (06:00 and 18:00, via `scripts/run-tester-cron.sh` + `scripts/run-developer-cron.sh` — see `EXECUTION_PLAN.md`) and on demand via `/orchestrate`.

## Ground rules for every agent

- Opaque session tokens, not JWT. Permission check → pre-signed URL (60s TTL) for every image. Async classification via BullMQ, never inline. pHash dedup before any Vision API call.
- No real cloud credentials, no Stripe, no git remote push without Abhishek's explicit go-ahead.
- No fabricated test results, no silently skipped regression coverage, no guessed specs — ambiguity goes to `agents/STATUS.md` as a pending decision, not into code.
