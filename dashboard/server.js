#!/usr/bin/env node
/**
 * PhotoSphere AI — Local Insights Dashboard
 * ------------------------------------------
 * Zero-dependency Node HTTP server (Node built-ins only). LOCAL USE ONLY.
 * This whole `dashboard/` folder is gitignored and never committed.
 *
 * It reads the four-agent coordination files live:
 *   - agents/STATUS.md         (current phase, sprint, tester run, bugs, pending decisions)
 *   - reports/*.md             (dated Tester regression reports -> pass-rate trend)
 *   - specs/*.md               (shipped / ready specs)
 *   - PhotoSphere_AI_Master_Roadmap.md (phase checklist progress)
 *
 * And it lets you QUEUE feature suggestions for the next /orchestrate cycle by
 * appending structured blocks to dashboard/FEATURE_QUEUE.md, which the Master /
 * Planner agents read (see the agent .md files).
 *
 * Run:  node dashboard/server.js        (from the project root)
 *   or: cd dashboard && node server.js
 * Then open http://localhost:4321
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.DASHBOARD_PORT || 4321;
const DASH_DIR = __dirname;
const ROOT = path.resolve(DASH_DIR, '..'); // project root
const QUEUE_FILE = path.join(DASH_DIR, 'FEATURE_QUEUE.md');
const SUGGESTIONS_FILE = path.join(DASH_DIR, 'suggestions.json');

// ---------- small fs helpers ----------
function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return ''; }
}
function listDir(p) {
  try { return fs.readdirSync(p); } catch (_) { return []; }
}

// ---------- STATUS.md parsing ----------
// Return the text under a "## <name>" heading, up to the next "## ".
function statusSection(md, name) {
  const re = new RegExp('^##\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'im');
  const m = md.match(re);
  if (!m) return '';
  const start = m.index + m[0].length;
  const rest = md.slice(start);
  const next = rest.search(/^##\s+/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}
function firstMeaningfulLine(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines[0] || '';
}

function parseStatus() {
  const md = readSafe(path.join(ROOT, 'agents', 'STATUS.md'));
  if (!md) return { available: false };

  const lastUpdated = (md.match(/\*\*Last updated:\*\*\s*(.+)/) || [])[1] || '';
  const phase = firstMeaningfulLine(statusSection(md, 'Current Phase'));
  const sprint = firstMeaningfulLine(statusSection(md, 'Current Sprint Goal'));
  const readySpec = firstMeaningfulLine(statusSection(md, 'Ready Spec (from Planner)'));

  // Open bugs
  const bugsSec = statusSection(md, 'Open Bugs');
  const noBugs = /^none/i.test(firstMeaningfulLine(bugsSec));

  // Pending decisions: count numbered items "N." at line start
  const pendingSec = statusSection(md, 'Pending Decisions Awaiting User Input');
  const pendingItems = (pendingSec.match(/^\s*\d+\.\s+\*\*/gm) || []).length;
  // The explicitly-blocking item is called out with "actually blocking"
  const blocking = /item actually blocking/i.test(pendingSec) || /blocking further work/i.test(pendingSec);

  return {
    available: true,
    lastUpdated: lastUpdated.trim(),
    phase,
    sprint,
    readySpec,
    openBugs: noBugs ? 0 : null, // null => see STATUS, non-trivial
    openBugsText: firstMeaningfulLine(bugsSec),
    pendingDecisions: pendingItems,
    hasBlockingDecision: blocking,
  };
}

// ---------- reports/ parsing (pass-rate trend) ----------
function parseReports() {
  const dir = path.join(ROOT, 'reports');
  const files = listDir(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f))
    .sort();
  const runs = files.map((f) => {
    const md = readSafe(path.join(dir, f));
    let passed = null, total = null, bugs = null;
    // Preferred format: "Passed: 52 / Failed: 0"
    let m = md.match(/Passed:\s*(\d+)\s*\/\s*Failed:\s*(\d+)/i);
    if (m) {
      passed = parseInt(m[1], 10);
      const failed = parseInt(m[2], 10);
      total = passed + failed;
      bugs = failed;
    } else {
      // Fallback: "X/X passed" or "X/X pass"
      m = md.match(/(\d+)\s*\/\s*(\d+)\s*(?:passed|pass\b)/i);
      if (m) { passed = parseInt(m[1], 10); total = parseInt(m[2], 10); }
      const bm = md.match(/(\d+)\s*bugs?\b/i);
      if (bm) bugs = parseInt(bm[1], 10);
    }
    return { file: f, date: f.replace(/\.md$/, ''), passed, total, bugs };
  });
  return runs;
}

// ---------- specs/ ----------
function parseSpecs() {
  const dir = path.join(ROOT, 'specs');
  return listDir(dir)
    .filter((f) => f.endsWith('.md') && f.toUpperCase() !== 'TEMPLATE.MD')
    .map((f) => f.replace(/\.md$/, ''));
}

// ---------- roadmap Phase 1 checklist progress ----------
function parseRoadmap() {
  const md = readSafe(path.join(ROOT, 'PhotoSphere_AI_Master_Roadmap.md'));
  if (!md) return { available: false };
  // Phase 1 block: from "## 7. Phase 1" to "## 8. Phase 2"
  const start = md.search(/^##\s*7\.\s*Phase 1/im);
  const end = md.search(/^##\s*8\.\s*Phase 2/im);
  const block = start !== -1 ? md.slice(start, end === -1 ? undefined : end) : md;
  const total = (block.match(/- \[[ xX]\]/g) || []).length;
  const done = (block.match(/- \[[xX]\]/g) || []).length;
  return { available: true, phase1Total: total, phase1Done: done };
}

// ---------- FEATURE_QUEUE.md read/write ----------
const ITEM_OPEN = /<!--\s*feature-queue-item\s+id=([\w-]+)\s+queued=([^\s]+)\s*-->/g;

function readQueue() {
  const md = readSafe(QUEUE_FILE);
  const items = [];
  let m;
  ITEM_OPEN.lastIndex = 0;
  while ((m = ITEM_OPEN.exec(md)) !== null) {
    items.push({ id: m[1], queued: m[2] });
  }
  return items;
}

function ensureQueueHeader() {
  if (fs.existsSync(QUEUE_FILE)) return;
  const header =
`# PhotoSphere AI — Feature Queue

> **Local, uncommitted queue** written by the insights dashboard (\`dashboard/server.js\`).
> The Master and Planner agents read this file at the start of every \`/orchestrate\`
> cycle: user-queued features are scoped **after** any open bugs but **before** the
> default next roadmap item. Checked items (\`[x]\`) have been picked up; leave them
> for history or delete via the dashboard.

---
`;
  fs.writeFileSync(QUEUE_FILE, header, 'utf8');
}

function queueFeature(s) {
  ensureQueueHeader();
  const existing = readQueue();
  if (existing.some((it) => it.id === s.id)) {
    return { ok: false, reason: 'already-queued' };
  }
  const now = new Date().toISOString();
  const block =
`
<!-- feature-queue-item id=${s.id} queued=${now} -->
### [ ] ${s.title}
- **Suggestion ID:** \`${s.id}\`
- **Phase:** ${s.phase}
- **Effort:** ${s.effort}   |   **Category:** ${s.category}   |   **Tier:** ${s.tier}${s.differentiator ? '   |   ⭐ differentiator' : ''}
- **Queued:** ${now} (via dashboard)
- **Why this matters:** ${s.rationale}
- **Dependencies:** ${(s.dependencies || []).join('; ') || 'none noted'}
- **What the agents should do:** ${s.queues}
<!-- /feature-queue-item -->
`;
  fs.appendFileSync(QUEUE_FILE, block, 'utf8');
  return { ok: true, queued: now };
}

function dequeueFeature(id) {
  const md = readSafe(QUEUE_FILE);
  if (!md) return { ok: false, reason: 'empty' };
  const re = new RegExp(
    '\\n?<!--\\s*feature-queue-item\\s+id=' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    '\\s+queued=[^\\s]+\\s*-->[\\s\\S]*?<!--\\s*/feature-queue-item\\s*-->\\n?',
    'g'
  );
  if (!re.test(md)) return { ok: false, reason: 'not-found' };
  fs.writeFileSync(QUEUE_FILE, md.replace(re, '\n'), 'utf8');
  return { ok: true };
}

// ---------- suggestions + queue merge ----------
function loadSuggestions() {
  try {
    const data = JSON.parse(readSafe(SUGGESTIONS_FILE));
    return data.suggestions || [];
  } catch (_) { return []; }
}

// ---------- HTTP ----------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function collectBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathName = url.pathname;

  // --- API ---
  if (pathName === '/api/insights' && req.method === 'GET') {
    return sendJSON(res, 200, {
      generatedAt: new Date().toISOString(),
      status: parseStatus(),
      reports: parseReports(),
      specs: parseSpecs(),
      roadmap: parseRoadmap(),
    });
  }

  if (pathName === '/api/suggestions' && req.method === 'GET') {
    const queued = new Set(readQueue().map((q) => q.id));
    const items = loadSuggestions().map((s) => ({ ...s, queued: queued.has(s.id) }));
    return sendJSON(res, 200, { suggestions: items });
  }

  if (pathName === '/api/queue' && req.method === 'GET') {
    return sendJSON(res, 200, { queue: readQueue() });
  }

  if (pathName === '/api/queue' && req.method === 'POST') {
    const body = await collectBody(req);
    let payload;
    try { payload = JSON.parse(body); } catch (_) { return sendJSON(res, 400, { error: 'bad json' }); }
    const s = loadSuggestions().find((x) => x.id === payload.id);
    if (!s) return sendJSON(res, 404, { error: 'unknown suggestion id' });
    const result = queueFeature(s);
    return sendJSON(res, result.ok ? 200 : 409, result);
  }

  if (pathName.startsWith('/api/queue/') && req.method === 'DELETE') {
    const id = decodeURIComponent(pathName.slice('/api/queue/'.length));
    const result = dequeueFeature(id);
    return sendJSON(res, result.ok ? 200 : 404, result);
  }

  // --- static: index.html ---
  if (pathName === '/' || pathName === '/index.html') {
    const html = readSafe(path.join(DASH_DIR, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n  PhotoSphere AI dashboard  →  http://localhost:${PORT}`);
  console.log(`  Reading project root: ${ROOT}`);
  console.log(`  Feature queue file:   ${QUEUE_FILE}`);
  console.log(`  (local only — this folder is gitignored)\n`);
});
