const ks = Object.keys(__e).filter(k => !k.startsWith('__') && k.indexOf('.') > 0 && k.split('.').every(s => s !== '')).sort((a, b) => a.split('.').length - b.split('.').length);
for (const k of ks) {
  const parts = k.split('.');
  const leaf = parts.pop();
  let t = __e;
  let ok = true;
  for (const p of parts) {
    const v = t[p];
    if (v !== undefined && (v === null || typeof v !== 'object' || Array.isArray(v))) { ok = false; break; }
    t = v === undefined ? null : v;
    if (t === null) break;
  }
  if (!ok) continue;
  t = __e;
  for (const p of parts) { if (t[p] === undefined) t[p] = {}; t = t[p]; }
  t[leaf] = __e[k];
  delete __e[k];
}
