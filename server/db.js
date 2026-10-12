// SQLite persistence via node:sqlite (built into Node 22.13+ / 23.4+, no
// native build step). Two tables: projects own a model and a set of
// annotations. Swapping this for Postgres later is a matter of replacing the
// handful of query functions below; the HTTP layer never touches SQL.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function openDb(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'glossy.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
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
  `);

  const q = {
    listProjects: db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM annotations a WHERE a.project_id = p.id) AS annotation_count
      FROM projects p ORDER BY updated_at DESC`),
    getProject: db.prepare(`SELECT * FROM projects WHERE id = ?`),
    insertProject: db.prepare(`INSERT INTO projects (id, name, transform, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`),
    updateProject: db.prepare(`UPDATE projects SET name = ?, transform = ?, updated_at = ? WHERE id = ?`),
    setModel: db.prepare(`UPDATE projects SET model_url = ?, model_type = ?, model_name = ?, updated_at = ? WHERE id = ?`),
    deleteProject: db.prepare(`DELETE FROM projects WHERE id = ?`),
    listAnnotations: db.prepare(`SELECT * FROM annotations WHERE project_id = ? ORDER BY created_at`),
    listAllAnnotations: db.prepare(`SELECT * FROM annotations ORDER BY project_id, created_at`),
    getAnnotation: db.prepare(`SELECT * FROM annotations WHERE id = ? AND project_id = ?`),
    insertAnnotation: db.prepare(`
      INSERT INTO annotations (id, project_id, author, created_at, x, y, z, object_id, layer, audio_url, duration_ms, transcript, consent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    deleteAnnotation: db.prepare(`DELETE FROM annotations WHERE id = ? AND project_id = ?`),
    countAnnotations: db.prepare(`SELECT COUNT(*) AS n FROM annotations`),
    touchProject: db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`),
  };

  const now = () => new Date().toISOString();
  const projectRow = (r) => r && ({
    id: r.id, name: r.name,
    modelUrl: r.model_url, modelType: r.model_type, modelName: r.model_name,
    transform: JSON.parse(r.transform || '{}'),
    createdAt: r.created_at, updatedAt: r.updated_at,
    ...(r.annotation_count !== undefined ? { annotationCount: Number(r.annotation_count) } : {}),
  });
  const annotationRow = (r) => r && ({
    id: r.id, project: r.project_id, author: r.author, createdAt: r.created_at,
    anchor: { x: r.x, y: r.y, z: r.z, ...(r.object_id ? { objectId: r.object_id } : {}) },
    layer: r.layer, audioUrl: r.audio_url, durationMs: r.duration_ms, transcript: r.transcript, consent: !!r.consent,
  });

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
      update: (id, { name, transform }) => {
        const cur = api.projects.get(id);
        if (!cur) return null;
        q.updateProject.run(name ?? cur.name, JSON.stringify(transform ?? cur.transform), now(), id);
        return api.projects.get(id);
      },
      setModel: (id, { url, type, name }) => { q.setModel.run(url, type, name, now(), id); return api.projects.get(id); },
      remove: (id) => q.deleteProject.run(id).changes > 0,
    },
    annotations: {
      list: (projectId) => q.listAnnotations.all(projectId).map(annotationRow),
      listAll: () => q.listAllAnnotations.all().map(annotationRow),
      get: (projectId, id) => annotationRow(q.getAnnotation.get(id, projectId)),
      create: (projectId, a) => {
        const id = a.id || randomUUID();
        const t = a.createdAt || now();
        q.insertAnnotation.run(id, projectId, a.author, t, a.x, a.y, a.z, a.objectId ?? null, a.layer || 'default',
          a.audioUrl, a.durationMs ?? null, a.transcript ?? null, a.consent ? 1 : 0);
        q.touchProject.run(t, projectId);
        return api.annotations.get(projectId, id);
      },
      remove: (projectId, id) => {
        const row = api.annotations.get(projectId, id);
        if (!row) return null;
        q.deleteAnnotation.run(id, projectId);
        return row;
      },
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
