import { io } from 'socket.io-client';

async function json(res) {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.status === 204 ? null : res.json();
}

export const projects = {
  list: () => fetch('/api/projects').then(json),
  get: (id) => fetch(`/api/projects/${id}`).then(json),
  create: (name) => fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }).then(json),
  update: (id, patch) => fetch(`/api/projects/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }).then(json),
  remove: (id) => fetch(`/api/projects/${id}`, { method: 'DELETE' }).then(json),
};

export const assets = {
  list: (project) => fetch(`/api/projects/${project}/assets`).then(json),
  update: (project, id, patch) => fetch(`/api/projects/${project}/assets/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }).then(json),
  remove: (project, id) => fetch(`/api/projects/${project}/assets/${id}`, { method: 'DELETE' }).then(json),
  /** @param {File} model main file; @param {File[]} files sidecars (.bin, textures, .mtl); extra: { mode } for images */
  upload: (project, model, files = [], onProgress, extra = {}) => new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('model', model, model.name);
    for (const f of files) fd.append('files', f, f.name);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/projects/${project}/assets`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(JSON.parse(xhr.responseText || '{}').error || xhr.statusText)));
    xhr.onerror = () => reject(new Error('upload failed'));
    xhr.send(fd);
  }),
};

export const annotations = {
  list: (project) => fetch(`/api/projects/${project}/annotations`).then(json),
  remove: (project, id) => fetch(`/api/projects/${project}/annotations/${id}`, { method: 'DELETE' }).then(json),
  transcribe: (project, id) => fetch(`/api/projects/${project}/annotations/${id}/transcribe`, { method: 'POST' }).then(json),
  update: (project, id, patch) => fetch(`/api/projects/${project}/annotations/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }).then(json),
  /** parent: id of the annotation this one replies to; pose: head samples over the clip; prompt/mode: interview question answered */
  create: async ({ project, blob, durationMs, anchor, author, layer, consent, objectId, parent, period, pose, prompt, mode, language }) => {
    const fd = new FormData();
    fd.append('audio', blob, 'clip');
    fd.append('x', anchor.x); fd.append('y', anchor.y); fd.append('z', anchor.z);
    if (objectId) fd.append('objectId', objectId);
    fd.append('author', author);
    fd.append('layer', layer);
    fd.append('consent', String(consent));
    fd.append('durationMs', durationMs);
    if (parent) fd.append('parent', parent);
    if (period) fd.append('period', JSON.stringify(period));
    if (pose?.length) fd.append('pose', JSON.stringify(pose));
    if (prompt) fd.append('prompt', prompt);
    if (mode) fd.append('mode', mode);
    if (language) fd.append('language', language);
    return fetch(`/api/projects/${project}/annotations`, { method: 'POST', body: fd }).then(json);
  },
};

export function connect(handlers) {
  const socket = io({ transports: ['websocket', 'polling'] });
  socket.on('connect', () => handlers.onStatus?.('connected'));
  socket.on('disconnect', () => handlers.onStatus?.('disconnected'));
  socket.on('annotation:all', handlers.onAll);
  socket.on('annotation:new', handlers.onNew);
  socket.on('annotation:deleted', handlers.onDeleted);
  socket.on('annotation:updated', handlers.onUpdated);
  socket.on('project:updated', handlers.onProjectUpdated);
  socket.on('project:created', handlers.onProjectsChanged);
  socket.on('project:deleted', handlers.onProjectsChanged);
  return { socket, join: (project) => socket.emit('join', { project }) };
}
