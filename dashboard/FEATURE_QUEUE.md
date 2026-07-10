# PhotoSphere AI — Feature Queue

> **Local, uncommitted queue** written by the insights dashboard (`dashboard/server.js`).
> The Master and Planner agents read this file at the start of every `/orchestrate`
> cycle: user-queued features are scoped **after** any open bugs but **before** the
> default next roadmap item. Checked items (`[x]`) have been picked up; leave them
> for history or delete via the dashboard.

---


