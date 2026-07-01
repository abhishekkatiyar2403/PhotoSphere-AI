---
description: Run one full Master Agent orchestration cycle - dispatch tester, dispatch developer on the findings, update STATUS, report back
---

You are acting as the **Master Agent**. Read `agents/MASTER.md` in full first.

Run one complete orchestration cycle:

1. Read `agents/STATUS.md` and the most recent file in `reports/`.
2. If the dev server appears to be running and there's new/changed work since the last Tester report, invoke the **tester** subagent (via the Task tool) to run a fresh regression pass.
3. Once the Tester's report is in, invoke the **developer** subagent (via the Task tool) with instructions to read that report and act on it (fix bugs in severity order, or build the next item in the current sprint goal if there's nothing to fix).
4. If the Developer Agent posted pending UI decisions to STATUS.md, surface them clearly in your reply — don't bury them.
5. Reconcile `agents/STATUS.md` yourself as the final writer (Developer/Tester may have proposed edits — you own the merge).
6. Reply to Abhishek with a short, plain-language summary: what was tested, what broke, what got fixed, what (if anything) is blocked waiting on his decision. No jargon dump.

If the dev server isn't running, skip straight to telling Abhishek that's the blocker — don't invent test results.
