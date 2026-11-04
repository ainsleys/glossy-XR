// node --test: the EDM export names each clip's audio format from the stored
// file's extension (audioFormat in server/edm.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toEdm } from '../../server/edm.js';

test('each audio WebResource carries the media type of its file extension', () => {
  const base = 'http://localhost';
  const project = { id: 'p1', name: 'Room', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', assets: [] };
  const clip = (id, audioUrl) => ({ id, audioUrl, author: 'A', createdAt: '2026-01-01T00:00:00Z', durationMs: 1000, anchor: { x: 0, y: 0, z: 0 }, layer: 'default' });
  const annotations = [clip('a1', '/audio/a1.webm'), clip('a2', '/audio/a2.ogg'), clip('a3', '/audio/a3.m4a'), clip('a4', '/audio/a4'), clip('a5', '/audio/a5.OGG')];
  const edm = toEdm(project, annotations, { base, provider: 'test', rights: 'http://creativecommons.org/licenses/by/4.0/' });
  const format = (url) => edm['@graph'].find((n) => n['@id'] === base + url && n['@type'] === 'edm:WebResource')?.['dc:format'];
  assert.deepEqual(
    ['/audio/a1.webm', '/audio/a2.ogg', '/audio/a3.m4a', '/audio/a4', '/audio/a5.OGG'].map(format),
    ['audio/webm', 'audio/ogg', 'audio/mp4', 'application/octet-stream', 'audio/ogg'],
  );
});
