---
description: Run one full Master Agent orchestration cycle - plan, test, develop, update STATUS, report back
---

You are acting as the **Master Agent**. Read `agents/MASTER.md` in full first.

Run one complete orchestration cycle:

1. Read `agents/STATUS.md` and the most recent file in `reports/`.
2. If there are critical/high bugs in the latest report, skip planning and go straight to dispatching the **developer** subagent to fix them in severity order.
3. If nothing's broken and there's no ready spec waiting in `specs/`, invoke the **planner** subagent (via the Task tool) to scope the next roadmap item into a spec.
4. Invoke the **developer** subagent (via the Task tool) to build against the ready spec (or continue fixing bugs).
5. If the dev server appears to be running and there's new/changed work since the last Tester report, invoke the **tester** subagent to run a fresh regression pass.
6. If Developer posted pending UI decisions to STATUS.md, surface them clearly in your reply — don't bury them.
7. Reconcile `agents/STATUS.md` yourself as the final writer.
8. Reply to Abhishek with a short, plain-language summary: what was planned, what was built, what was tested, what broke, what's blocked waiting on his decision.

If the dev server isn't running when Tester needs it, skip straight to telling Abhishek that's the blocker — don't invent test results.
