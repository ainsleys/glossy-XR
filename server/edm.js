// A project's contributions as a Europeana Data Model (EDM) record set in
// JSON-LD, alongside the native export. This is the "feed back into the asset
// metadata" shape: an institution that already describes the scanned place
// with EDM (or Dublin Core, which EDM reuses) can take these records as they
// are, and the CIDOC-CRM view is one mapping away because every statement is
// a plain triple.
//
// One record per clip, following EDM's one-to-one principle as restated in
// Europeana's "Review of EDM to support 3D" (Isaac ed., 2024, v1.2):
//
//   edm:ProvidedCHO  the contribution itself: who said it (dc:creator), when
//                    (dcterms:created), where in the place (dcterms:spatial
//                    and the scene anchor), the time it talks about
//                    (dcterms:temporal -> edm:TimeSpan), what was said
//                    (dc:description, language-tagged), what question it
//                    answers, what it replies to (edm:isRelatedTo).
//   edm:WebResource  the audio file with its technical data and paradata
//                    (dc:format, ebucore:duration, dcterms:provenance: how
//                    it was recorded, how it was transcribed), and each
//                    photograph a reviewer linked to the clip.
//   ore:Aggregation  ties them together, names the data provider, states the
//                    rights (one licence for the whole set, see GLOSSY_RIGHTS),
//                    marks the record as user-generated (edm:ugc), and points
//                    at the audio (edm:isShownBy), the photographs
//                    (edm:hasView) and the clip in the room (edm:isShownAt).
//
// The project is a ProvidedCHO of its own (edm:type 3D) with dcterms:hasPart
// to every contribution and the scene assets as its web resources.
//
// What EDM has no place for stays under the `glossy:` namespace (the scene
// anchor, the layer, the mode, the question, a pointer to the full native
// record with pose trace and word timings). Clips whose author withdrew
// consent are left out; the project node says how many.

const CONTEXT = {
  dc: 'http://purl.org/dc/elements/1.1/',
  dcterms: 'http://purl.org/dc/terms/',
  edm: 'http://www.europeana.eu/schemas/edm/',
  ore: 'http://www.openarchives.org/ore/terms/',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  ebucore: 'http://www.ebu.ch/metadata/ontologies/ebucore/ebucore#',
  glossy: 'https://github.com/ainsleys/glossy-XR#glossy-',
  'edm:aggregatedCHO': { '@type': '@id' },
  'edm:isShownBy': { '@type': '@id' },
  'edm:isShownAt': { '@type': '@id' },
  'edm:hasView': { '@type': '@id' },
  'edm:isRelatedTo': { '@type': '@id' },
  'edm:rights': { '@type': '@id' },
  'dcterms:temporal': { '@type': '@id' },
  'dcterms:isPartOf': { '@type': '@id' },
  'dcterms:hasPart': { '@type': '@id' },
  'glossy:replyTo': { '@type': '@id' },
  'glossy:nativeRecord': { '@type': '@id' },
};

const IMAGE = /^(png|jpe?g|webp|gif)$/i, VIDEO = /^(mp4|webm|mov)$/i;
const assetKind = (type) => (type === 'image' || IMAGE.test(type || '') ? 'IMAGE' : type === 'video' || VIDEO.test(type || '') ? 'VIDEO' : '3D');   // asset types are glb, ply, splat, image, video …
const isoDuration = (ms) => `PT${(Math.round(ms) / 1000).toFixed(ms % 1000 ? 1 : 0)}S`;
const firstWords = (text, n = 8) => { const w = text.trim().split(/\s+/); return w.slice(0, n).join(' ') + (w.length > n ? ' …' : ''); };

export function toEdm(project, annotations, { base, provider, rights }) {
  const pid = project.id;
  const abs = (p) => (/^https?:\/\//.test(p) ? p : base + p);
  const choOf = (id) => abs(`/api/projects/${pid}/annotations/${id}`);
  const projectCho = abs(`/api/projects/${pid}`);
  const nativeRecord = abs(`/api/projects/${pid}/export`);
  const included = annotations.filter((a) => a.consent !== false);
  const ids = new Set(included.map((a) => a.id));
  const graph = [];

  // one edm:TimeSpan per distinct period
  const spans = new Map();
  const spanFor = (period) => {
    if (!period || !(period.from || period.to || period.label)) return null;
    const key = JSON.stringify([period.from || '', period.to || '', period.label || '']);
    if (!spans.has(key)) {
      const node = { '@id': abs(`/api/projects/${pid}/export#timespan-${spans.size + 1}`), '@type': 'edm:TimeSpan', 'skos:prefLabel': period.label || [period.from, period.to].filter(Boolean).join('–') };
      if (period.from) node['edm:begin'] = String(period.from);
      if (period.to) node['edm:end'] = String(period.to);
      spans.set(key, node);
    }
    return spans.get(key)['@id'];
  };

  // the place: the project with its scene assets
  const assets = project.assets || [];
  graph.push({
    '@id': projectCho, '@type': 'edm:ProvidedCHO',
    'dc:title': project.name,
    'dc:type': 'place with voice annotations',
    'edm:type': '3D',
    'dcterms:created': project.createdAt,
    'dcterms:modified': project.updatedAt,
    'dcterms:hasPart': included.map((a) => choOf(a.id)),
    'glossy:contributions': included.length,
    'glossy:withheldForConsent': annotations.length - included.length,
    'glossy:nativeRecord': nativeRecord,
  });
  for (const as of assets) graph.push({ '@id': abs(as.url), '@type': 'edm:WebResource', 'dc:title': as.name, 'dc:format': as.type, 'edm:type': assetKind(as.type), 'dcterms:created': as.createdAt, 'edm:rights': rights });
  const scene = assets.find((as) => assetKind(as.type) === '3D') || assets[0];
  graph.push({
    '@id': projectCho + '#aggregation', '@type': 'ore:Aggregation',
    'edm:aggregatedCHO': projectCho,
    'edm:dataProvider': provider, 'edm:provider': provider,
    'edm:rights': rights,
    'edm:isShownAt': abs(`/?project=${pid}`),
    ...(scene ? { 'edm:isShownBy': abs(scene.url) } : {}),
    ...(assets.length > 1 ? { 'edm:hasView': assets.filter((as) => as !== scene).map((as) => abs(as.url)) } : {}),
  });

  // one record per contribution
  for (const a of included) {
    const cho = choOf(a.id), audio = abs(a.audioUrl);
    const tr = a.transcription || {};
    const lang = tr.language || a.language || null;
    const text = tr.unclear ? '' : (a.transcript || '');
    const photos = (a.links || []).filter((l) => l.url);
    const node = {
      '@id': cho, '@type': 'edm:ProvidedCHO',
      'dc:title': a.prompt ? `Answer to “${a.prompt}”` : text ? firstWords(text) : `Voice annotation by ${a.author}`,
      'dc:creator': a.author,
      'dcterms:created': a.createdAt,
      'dc:type': a.parent ? 'reply to a voice annotation' : a.mode === 'interview' ? 'interview answer' : 'voice annotation',
      'edm:type': 'SOUND',
      'dcterms:isPartOf': projectCho,
      'dcterms:spatial': [project.name, a.anchor?.objectId ? `on ${a.anchor.objectId}` : ''].filter(Boolean).join(', '),
      'glossy:anchor': { x: a.anchor?.x, y: a.anchor?.y, z: a.anchor?.z, ...(a.anchor?.objectId ? { objectId: a.anchor.objectId } : {}) },
      'glossy:mode': a.mode || 'walk',
      'glossy:layer': a.layer,
      ...(a.hands ? { 'glossy:gesture': true } : {}),
      'glossy:nativeRecord': nativeRecord,
    };
    if (text) node['dc:description'] = lang ? { '@value': text, '@language': lang } : text;
    if (lang) node['dc:language'] = lang;
    if (a.prompt) node['glossy:prompt'] = a.prompt;
    const ts = spanFor(a.period);
    if (ts) node['dcterms:temporal'] = ts;
    if (a.parent && ids.has(a.parent)) { node['edm:isRelatedTo'] = choOf(a.parent); node['glossy:replyTo'] = choOf(a.parent); }
    graph.push(node);

    const provenance = [
      `Recorded in Glossy XR ${a.poseSource === 'xr' ? 'in a headset' : 'on a desktop'} at the scene anchor; the viewpoint trace${a.hands ? ` and a hand-gesture trace of ${a.hands.frames.length} frames` : ''} ${a.hands ? 'are' : 'is'} in the native record.`,
      tr.status === 'done' && tr.model ? `Transcribed by ${tr.model} (${tr.backend})${lang ? `, language ${lang} ${tr.detected ? 'detected' : 'set by the project'}` : ''}${tr.unclear ? '; the transcript was rejected as unclear' : ''}.` : tr.status === 'failed' ? 'Transcription failed.' : 'Not transcribed.',
    ].join(' ');
    graph.push({
      '@id': audio, '@type': 'edm:WebResource',
      'dc:format': 'audio/webm',
      'ebucore:duration': isoDuration(a.durationMs || 0),
      'dcterms:extent': `${((a.durationMs || 0) / 1000).toFixed(1)} s`,
      'dcterms:created': a.createdAt,
      'dc:creator': a.author,
      'edm:rights': rights,
      'dcterms:provenance': provenance,
    });
    for (const l of photos) graph.push({ '@id': abs(l.url), '@type': 'edm:WebResource', 'dc:title': l.title || l.url, ...(l.kind === 'image' ? { 'edm:type': 'IMAGE' } : {}), 'edm:rights': rights });

    graph.push({
      '@id': cho + '#aggregation', '@type': 'ore:Aggregation',
      'edm:aggregatedCHO': cho,
      'edm:dataProvider': provider, 'edm:provider': provider,
      'edm:rights': rights,
      'edm:ugc': 'true',
      'edm:isShownBy': audio,
      'edm:isShownAt': abs(`/?project=${pid}&focus=${a.id}`),
      ...(photos.length ? { 'edm:hasView': photos.map((l) => abs(l.url)) } : {}),
    });
  }
  graph.push(...spans.values());
  return { '@context': CONTEXT, '@graph': graph };
}
