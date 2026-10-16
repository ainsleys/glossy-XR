// SQLite persistence via node:sqlite (built into Node 22.13+ / 23.4+, no
// native build step). Three tables: projects own assets and annotations. Swapping this for Postgres later is a matter of replacing the
// handful of query functions below; the HTTP layer never touches SQL.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function openDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'glossy.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;   -- wait for a competing writer (a seeding script, a checkpoint) instead of failing with 'database is locked'
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      model_url   TEXT,
      model_type  TEXT,
      model_name  TEXT,
      transform   TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS annotations (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      author      TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
      object_id   TEXT,
      layer       TEXT NOT NULL DEFAULT 'default',
      audio_url   TEXT NOT NULL,
      duration_ms INTEGER,
      transcript  TEXT,
      consent     INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS annotations_project ON annotations(project_id, created_at);
    CREATE TABLE IF NOT EXISTS assets (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      url         TEXT NOT NULL,
      type        TEXT NOT NULL,
      name        TEXT NOT NULL,
      transform   TEXT NOT NULL DEFAULT '{}',
      options     TEXT NOT NULL DEFAULT '{}',
      visible     INTEGER NOT NULL DEFAULT 1,
      sort        INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS assets_project ON assets(project_id, sort, created_at);
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      session     TEXT NOT NULL,
      t           INTEGER NOT NULL,        -- ms since the client session began
      at          TEXT NOT NULL,           -- client wall clock, ISO
      received    TEXT NOT NULL,           -- server wall clock, ISO
      kind        TEXT NOT NULL,
      data        TEXT                     -- JSON
    );
    CREATE INDEX IF NOT EXISTS events_session ON events(project_id, session, id);
  `);
  // columns added after the first release
  const addCols = (table, defs) => {
    const have = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    for (const [name, decl] of defs) if (!have.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  };
  addCols('annotations', [
    ['transcript_status', 'TEXT'], ['transcript_meta', 'TEXT'],
    ['parent_id', 'TEXT'],          // reply to another annotation in the same project
    ['period', 'TEXT'],             // temporal reference: JSON {from, to, label} or NULL = unspecified
    ['pose', 'TEXT'],               // author viewpoint over the clip: JSON [{t, p:[x,y,z], q:[x,y,z,w]}]
    ['pose_source', 'TEXT'],        // xr (headset pose) | desktop (mouse-steered camera)
    ['prompt', 'TEXT'],             // the question this clip answers (interview mode)
    ['mode', 'TEXT'],               // walk | interview
    ['language', 'TEXT'],           // language requested for transcription; detected language lives in transcript_meta
    ['links', 'TEXT'],              // attachments a reviewer linked to the clip: JSON [{kind, asset, url, title}]
    ['hands', 'TEXT'],              // hand joints over the clip (headset hand tracking): JSON {joints, rate, frames:[{t,l,r}]}
  ]);
  addCols('projects', [
    ['language', 'TEXT'],           // default transcription language for the project; NULL = detect
    ['script', 'TEXT'],             // interview script: JSON {questions:[{id, text, ...}]}
  ]);
  db.exec(`CREATE INDEX IF NOT EXISTS annotations_parent ON annotations(project_id, parent_id)`);

  // every annotation read carries its reply count in one query
  const ANN = `SELECT a.*, (SELECT COUNT(*) FROM annotations r WHERE r.project_id = a.project_id AND r.parent_id = a.id) AS reply_count FROM annotations a`;
  // migrate single-model projects into the assets table
  for (const r of db.prepare(`SELECT id, model_url, model_type, model_name, transform, created_at FROM projects WHERE model_url IS NOT NULL`).all()) {
    db.prepare(`INSERT INTO assets (id, project_id, url, type, name, transform, options, visible, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, '{}', 1, 0, ?)`)
      .run(randomUUID().slice(0, 8), r.id, r.model_url, r.model_type, r.model_name, r.transform || '{}', r.created_at);
    db.prepare(`UPDATE projects SET model_url = NULL, model_type = NULL, model_name = NULL, transform = '{}' WHERE id = ?`).run(r.id);
  }

  const q = {
    listProjects: db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM annotations a WHERE a.project_id = p.id) AS annotation_count
      FROM projects p ORDER BY updated_at DESC`),
    getProject: db.prepare(`SELECT * FROM projects WHERE id = ?`),
    insertProject: db.prepare(`INSERT INTO projects (id, name, transform, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`),
    updateProject: db.prepare(`UPDATE projects SET name = ?, transform = ?, language = ?, script = ?, updated_at = ? WHERE id = ?`),
    setModel: db.prepare(`UPDATE projects SET model_url = ?, model_type = ?, model_name = ?, updated_at = ? WHERE id = ?`),
    deleteProject: db.prepare(`DELETE FROM projects WHERE id = ?`),
    listAnnotations: db.prepare(`${ANN} WHERE a.project_id = ? ORDER BY a.created_at`),
    listAllAnnotations: db.prepare(`${ANN} ORDER BY a.project_id, a.created_at`),
    getAnnotation: db.prepare(`${ANN} WHERE a.id = ? AND a.project_id = ?`),
    listChildren: db.prepare(`SELECT id FROM annotations WHERE parent_id = ? AND project_id = ?`),
    detachChildren: db.prepare(`UPDATE annotations SET parent_id = NULL WHERE parent_id = ? AND project_id = ?`),
    insertAnnotation: db.prepare(`
      INSERT INTO annotations (id, project_id, author, created_at, x, y, z, object_id, layer, audio_url, duration_ms, transcript, transcript_status, consent,
                               parent_id, period, pose, pose_source, prompt, mode, language, hands)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateAnnotation: db.prepare(`UPDATE annotations SET layer = ?, period = ?, consent = ?, links = ?, language = ? WHERE id = ? AND project_id = ?`),
    setTranscript: db.prepare(`UPDATE annotations SET transcript = ?, transcript_status = ?, transcript_meta = ? WHERE id = ? AND project_id = ?`),
    listByTranscriptStatus: db.prepare(`${ANN} WHERE a.transcript_status = ? ORDER BY a.created_at`),
    deleteAnnotation: db.prepare(`DELETE FROM annotations WHERE id = ? AND project_id = ?`),
    countAnnotations: db.prepare(`SELECT COUNT(*) AS n FROM annotations`),
    touchProject: db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`),
    listAssets: db.prepare(`SELECT * FROM assets WHERE project_id = ? ORDER BY sort, created_at`),
    getAsset: db.prepare(`SELECT * FROM assets WHERE id = ? AND project_id = ?`),
    insertAsset: db.prepare(`INSERT INTO assets (id, project_id, url, type, name, transform, options, visible, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateAsset: db.prepare(`UPDATE assets SET name = ?, transform = ?, options = ?, visible = ?, sort = ? WHERE id = ? AND project_id = ?`),
    deleteAsset: db.prepare(`DELETE FROM assets WHERE id = ? AND project_id = ?`),
    countAssets: db.prepare(`SELECT COUNT(*) AS n FROM assets WHERE project_id = ?`),
    insertEvent: db.prepare(`INSERT INTO events (project_id, session, t, at, received, kind, data) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    listEvents: db.prepare(`SELECT * FROM events WHERE project_id = ? AND (? IS NULL OR session = ?) AND id > ? ORDER BY id LIMIT ?`),
    listSessions: db.prepare(`
      SELECT session, MIN(at) AS started, MAX(at) AS ended, COUNT(*) AS n,
             (SELECT data FROM events s WHERE s.project_id = e.project_id AND s.session = e.session AND s.kind = 'session:start' ORDER BY id LIMIT 1) AS start_data
      FROM events e WHERE project_id = ? GROUP BY session ORDER BY started DESC`),
  };

  const now = () => new Date().toISOString();
  const assetRow = (r) => r && ({
    id: r.id, project: r.project_id, url: r.url, type: r.type, name: r.name,
    transform: JSON.parse(r.transform || '{}'), options: JSON.parse(r.options || '{}'),
    visible: !!r.visible, sort: r.sort, createdAt: r.created_at,
  });
  const projectRow = (r) => r && ({
    id: r.id, name: r.name,
    language: r.language || null, script: safeJson(r.script, null),
    createdAt: r.created_at, updatedAt: r.updated_at,
    assets: q.listAssets.all(r.id).map(assetRow),
    ...(r.annotation_count !== undefined ? { annotationCount: Number(r.annotation_count) } : {}),
  });
  const annotationRow = (r) => r && ({
    id: r.id, project: r.project_id, author: r.author, createdAt: r.created_at,
    anchor: { x: r.x, y: r.y, z: r.z, ...(r.object_id ? { objectId: r.object_id } : {}) },
    period: safeJson(r.period, null),
    parent: r.parent_id || null,
    replies: Number(r.reply_count || 0),
    mode: r.mode || 'walk', prompt: r.prompt || null, language: r.language || null,
    pose: safeJson(r.pose, []), poseSource: r.pose_source || null, hands: safeJson(r.hands, null), links: safeJson(r.links, []),
    layer: r.layer, audioUrl: r.audio_url, durationMs: r.duration_ms, transcript: r.transcript, consent: !!r.consent,
    transcription: { status: r.transcript_status || (r.transcript ? 'done' : 'none'), ...safeJson(r.transcript_meta) },
  });
  function safeJson(t, empty = {}) { try { return t ? JSON.parse(t) : empty; } catch { return empty; } }

  const api = {
    projects: {
      list: () => q.listProjects.all().map(projectRow),
      get: (id) => projectRow(q.getProject.get(id)),
      create: ({ name, transform = {} }) => {
        const id = randomUUID().slice(0, 8);
        const t = now();
        q.insertProject.run(id, name, JSON.stringify(transform), t, t);
        return api.projects.get(id);
      },
      update: (id, { name, transform, language, script }) => {
        const cur = api.projects.get(id);
        if (!cur) return null;
        const row = q.getProject.get(id);
        q.updateProject.run(name ?? cur.name, JSON.stringify(transform ?? JSON.parse(row.transform || '{}')),
          language === undefined ? row.language : language, script === undefined ? row.script : (script ? JSON.stringify(script) : null), now(), id);
        return api.projects.get(id);
      },
      remove: (id) => q.deleteProject.run(id).changes > 0,
    },
    assets: {
      list: (projectId) => q.listAssets.all(projectId).map(assetRow),
      get: (projectId, id) => assetRow(q.getAsset.get(id, projectId)),
      create: (projectId, { url, type, name, transform = {}, options = {} }) => {
        const id = randomUUID().slice(0, 8);
        const sort = q.countAssets.get(projectId).n;
        q.insertAsset.run(id, projectId, url, type, name, JSON.stringify(transform), JSON.stringify(options), 1, sort, now());
        q.touchProject.run(now(), projectId);
        return api.assets.get(projectId, id);
      },
      update: (projectId, id, patch) => {
        const cur = api.assets.get(projectId, id);
        if (!cur) return null;
        q.updateAsset.run(patch.name ?? cur.name, JSON.stringify(patch.transform ?? cur.transform), JSON.stringify(patch.options ?? cur.options),
          (patch.visible ?? cur.visible) ? 1 : 0, patch.sort ?? cur.sort, id, projectId);
        q.touchProject.run(now(), projectId);
        return api.assets.get(projectId, id);
      },
      remove: (projectId, id) => { const row = api.assets.get(projectId, id); if (row) q.deleteAsset.run(id, projectId); return row; },
    },
    annotations: {
      list: (projectId) => q.listAnnotations.all(projectId).map(annotationRow),
      listAll: () => q.listAllAnnotations.all().map(annotationRow),
      get: (projectId, id) => annotationRow(q.getAnnotation.get(id, projectId)),
      create: (projectId, a) => {
        const id = a.id || randomUUID();
        const t = a.createdAt || now();
        q.insertAnnotation.run(id, projectId, a.author, t, a.x, a.y, a.z, a.objectId ?? null, a.layer || 'default',
          a.audioUrl, a.durationMs ?? null, a.transcript ?? null, a.transcriptStatus ?? (a.transcript ? 'done' : 'pending'), a.consent ? 1 : 0,
          a.parent ?? null, a.period ? JSON.stringify(a.period) : null, a.pose?.length ? JSON.stringify(a.pose) : null,
          a.pose?.length ? (a.poseSource || null) : null, a.prompt ?? null, a.mode ?? null, a.language ?? null, a.hands ? JSON.stringify(a.hands) : null);
        q.touchProject.run(t, projectId);
        return api.annotations.get(projectId, id);
      },
      /** patch: { layer?, period? (object or null), consent?, links? (array), language? (code or null) } */
      update: (projectId, id, patch) => {
        const cur = api.annotations.get(projectId, id);
        if (!cur) return null;
        const period = patch.period === undefined ? cur.period : patch.period;
        const links = patch.links === undefined ? cur.links : patch.links;
        const language = patch.language === undefined ? cur.language : patch.language;
        q.updateAnnotation.run(patch.layer ?? cur.layer, period ? JSON.stringify(period) : null, (patch.consent ?? cur.consent) ? 1 : 0, links?.length ? JSON.stringify(links) : null, language, id, projectId);
        q.touchProject.run(now(), projectId);
        return api.annotations.get(projectId, id);
      },
      /** status: pending | done | failed | skipped; meta holds words, model, backend, language, ms, or error */
      setTranscript: (projectId, id, { transcript, status, meta = {} }) => {
        q.setTranscript.run(transcript ?? null, status, JSON.stringify(meta), id, projectId);
        return api.annotations.get(projectId, id);
      },
      listByTranscriptStatus: (status) => q.listByTranscriptStatus.all(status).map(annotationRow),
      /** Removes the row; replies to it become roots. Returns the removed record with `detached`: the ids of those replies. */
      remove: (projectId, id) => {
        const row = api.annotations.get(projectId, id);
        if (!row) return null;
        const detached = q.listChildren.all(id, projectId).map((c) => c.id);
        q.detachChildren.run(id, projectId);
        q.deleteAnnotation.run(id, projectId);
        return { ...row, detached };
      },
    },
    // Session log: what the clients did, as events (shared/events in the README). Append-only; cascades with the project.
    events: {
      add: (projectId, session, events) => {
        const received = now();
        const tx = db.prepare('BEGIN'), end = db.prepare('COMMIT');
        tx.run();
        try { for (const e of events) q.insertEvent.run(projectId, session, e.t, e.at, received, e.kind, e.data === undefined ? null : JSON.stringify(e.data)); end.run(); }
        catch (err) { db.prepare('ROLLBACK').run(); throw err; }
        return events.length;
      },
      list: (projectId, { session = null, after = 0, limit = 20000 } = {}) => q.listEvents.all(projectId, session, session, after, limit).map((r) => ({ id: r.id, session: r.session, t: r.t, at: r.at, received: r.received, kind: r.kind, data: safeJson(r.data, null) })),
      sessions: (projectId) => q.listSessions.all(projectId).map((r) => ({ session: r.session, started: r.started, ended: r.ended, events: Number(r.n), ...(safeJson(r.start_data, {}) || {}) })),
    },
    /** One-time import of the pre-SQLite JSON store into a project. */
    importLegacyJson(file, projectName = 'default') {
      if (!fs.existsSync(file) || q.countAnnotations.get().n > 0) return 0;
      let rows;
      try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return 0; }
      if (!Array.isArray(rows) || rows.length === 0) return 0;
      const project = api.projects.list().find((p) => p.name === projectName) || api.projects.create({ name: projectName });
      for (const r of rows) {
        api.annotations.create(project.id, {
          id: r.id, author: r.author, createdAt: r.createdAt,
          x: r.anchor?.x, y: r.anchor?.y, z: r.anchor?.z, objectId: r.anchor?.objectId,
          layer: r.layer || r.timeLayer || 'default', audioUrl: r.audioUrl, durationMs: r.durationMs,
          transcript: r.transcript, consent: r.consent !== false,
        });
      }
      fs.renameSync(file, file + '.imported');
      return rows.length;
    },
    close: () => db.close(),
  };
  return api;
}
