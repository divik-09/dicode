const split = (t) => { if (!t) return []; const l = t.split('\n'); if (l.at(-1) === '') l.pop(); return l; };

/** Line diff: trims common prefix/suffix, then LCS on the middle (falls back to replace-all for huge inputs). */
export function diffLines(aText, bText) {
  const a = split(aText), b = split(bText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf), bm = b.slice(pre, b.length - suf);
  const ops = a.slice(0, pre).map((l) => [' ', l]);
  const n = am.length, m = bm.length;
  if (n * m > 4_000_000) {
    for (const l of am) ops.push(['-', l]);
    for (const l of bm) ops.push(['+', l]);
  } else {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) { ops.push([' ', am[i]]); i++; j++; }
      else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) { ops.push(['-', am[i]]); i++; }
      else { ops.push(['+', bm[j]]); j++; }
    }
  }
  for (const l of a.slice(a.length - suf)) ops.push([' ', l]);
  return ops;
}

/** Unified diff with hunk headers. Returns { text, added, removed }. */
export function unifiedDiff(oldText, newText, { context = 3, file = 'file' } = {}) {
  const ops = diffLines(oldText, newText);
  let oldNo = 1, newNo = 1;
  const rows = ops.map(([t, l]) => { const r = { t, l, o: oldNo, n: newNo }; if (t !== '+') oldNo++; if (t !== '-') newNo++; return r; });
  const changed = rows.map((r, i) => (r.t !== ' ' ? i : -1)).filter((i) => i >= 0);
  const added = rows.filter((r) => r.t === '+').length, removed = rows.filter((r) => r.t === '-').length;
  if (!changed.length) return { text: '', added, removed };
  const hunks = [];
  let start = Math.max(0, changed[0] - context), end = Math.min(rows.length - 1, changed[0] + context);
  for (const i of changed.slice(1)) {
    if (i - context <= end + 1) end = Math.min(rows.length - 1, i + context);
    else { hunks.push([start, end]); start = Math.max(0, i - context); end = Math.min(rows.length - 1, i + context); }
  }
  hunks.push([start, end]);
  const out = [`--- a/${file}`, `+++ b/${file}`];
  for (const [s, e] of hunks) {
    const seg = rows.slice(s, e + 1);
    const oc = seg.filter((r) => r.t !== '+').length, nc = seg.filter((r) => r.t !== '-').length;
    const os = seg.find((r) => r.t !== '+')?.o ?? seg[0].o, ns = seg.find((r) => r.t !== '-')?.n ?? seg[0].n;
    out.push(`@@ -${oc ? os : os - 1},${oc} +${nc ? ns : ns - 1},${nc} @@`);
    for (const r of seg) out.push(r.t + r.l);
  }
  return { text: out.join('\n'), added, removed };
}
