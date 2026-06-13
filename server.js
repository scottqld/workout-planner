'use strict';
const express  = require('express');
const Database = require('better-sqlite3');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');

const PORT     = process.env.PORT     || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const VID_DIR  = path.join(DATA_DIR, 'videos');
const DB_PATH  = path.join(DATA_DIR, 'workout.db');

fs.mkdirSync(VID_DIR, { recursive: true });

// ── Database ─────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS store (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);
const stmtGet = db.prepare('SELECT value FROM store WHERE key = ?');
const stmtAll = db.prepare('SELECT key, value FROM store');
const stmtSet = db.prepare(`
  INSERT INTO store (key, value, updated_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
`);

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '100mb' }));
app.use('/videos', express.static(VID_DIR));

// Serve frontend files explicitly (don't expose server.js / package.json)
for (const f of ['index.html', 'sw.js', 'manifest.json', 'icon.svg']) {
  app.get(f === 'index.html' ? '/' : `/${f}`, (_req, res) =>
    res.sendFile(path.join(__dirname, f))
  );
}

// ── Key-value store ───────────────────────────────────────────────────────────
app.get('/api/store', (_req, res) => {
  const out = {};
  for (const { key, value } of stmtAll.all()) {
    try { out[key] = JSON.parse(value); } catch { out[key] = value; }
  }
  res.json(out);
});

app.post('/api/store/:key', (req, res) => {
  stmtSet.run(req.params.key, JSON.stringify(req.body));
  res.json({ ok: true });
});

// ── Video upload ──────────────────────────────────────────────────────────────
const vidUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _f, cb) => cb(null, VID_DIR),
    filename:    (_req,  f,  cb) => cb(null, f.originalname),
  }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4 GB
});

app.post('/api/upload', vidUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ ok: true, filename: req.file.filename, url: `/videos/${encodeURIComponent(req.file.filename)}` });
});

// ── CSV helpers ───────────────────────────────────────────────────────────────
const csvEsc = v => { const s = String(v ?? ''); return /[,"\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
const toCsv  = (rows, cols) => [cols.join(','), ...rows.map(r => cols.map(c => csvEsc(r[c])).join(','))].join('\n');
const getVal = (key, fallback) => { const r = stmtGet.get(key); if (!r) return fallback; try { return JSON.parse(r.value); } catch { return fallback; } };

// ── CSV export ────────────────────────────────────────────────────────────────
app.get('/api/export/log.csv', (_req, res) => {
  const rows = getVal('wp-log', []).map(e => ({ date: e.date || '', class: e['class'] || '', notes: e.notes || '' }));
  res.setHeader('Content-Disposition', 'attachment; filename="log.csv"');
  res.setHeader('Content-Type', 'text/csv');
  res.send(toCsv(rows, ['date', 'class', 'notes']));
});

app.get('/api/export/classes.csv', (_req, res) => {
  const rows = [
    ...getVal('wp-files', []).map(c => ({ ...c, source: 'drive' })),
    ...getVal('wp-urls',  []).map(c => ({ ...c, source: 'link'  })),
  ];
  res.setHeader('Content-Disposition', 'attachment; filename="classes.csv"');
  res.setHeader('Content-Type', 'text/csv');
  res.send(toCsv(rows, ['name', 'category', 'duration', 'url', 'notes', 'instructor', 'source']));
});

// ── Week log import ───────────────────────────────────────────────────────────
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i+1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}

app.post('/api/import/log-week', memUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const lines = req.file.buffer.toString('utf-8').split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return res.status(400).json({ error: 'Empty or header-only file' });

  const hdr = lines[0].split(',').map(h => h.trim().toLowerCase());
  const di = hdr.indexOf('date'), ci = hdr.indexOf('class'), ni = hdr.indexOf('notes');
  if (di < 0 || ci < 0) return res.status(400).json({ error: 'CSV must have date and class columns' });

  const entries = lines.slice(1)
    .map(l => parseCsvLine(l))
    .map(c => ({ date: (c[di]||'').trim(), 'class': (c[ci]||'').trim(), notes: (c[ni]||'').trim() }))
    .filter(e => e.date && e['class']);

  if (!entries.length) return res.status(400).json({ error: 'No valid entries found' });

  const weekStart = mondayOf(entries.map(e => e.date).sort()[0]);
  const sunDt = new Date(weekStart + 'T00:00:00');
  sunDt.setDate(sunDt.getDate() + 6);
  const weekEnd = sunDt.toISOString().slice(0, 10);

  let log = getVal('wp-log', []);
  log = log.filter(e => !e.date || e.date < weekStart || e.date > weekEnd);
  log = [...log, ...entries].sort((a, b) => (a.date||'').localeCompare(b.date||''));
  log = log.map((e, i) => ({ ...e, _idx: i }));
  stmtSet.run('wp-log', JSON.stringify(log));

  res.json({ ok: true, imported: entries.length, weekStart, weekEnd });
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, '0.0.0.0', () => console.log(`Workout Planner running on http://0.0.0.0:${PORT}`));
