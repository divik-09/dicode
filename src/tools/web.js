import dns from 'node:dns/promises';
import net from 'node:net';

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
  }
  return true;
}

export async function assertPublicUrl(url, allowPrivate) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are supported');
  if (allowPrivate) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Local addresses are blocked (set web.allowPrivate to allow)');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Private network addresses are blocked (set web.allowPrivate to allow)');
  return u;
}

export function htmlToText(html) {
  const ent = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => '\n```\n' + c.replace(/<[^>]+>/g, '') + '\n```\n')
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, h, t) => `${t.replace(/<[^>]+>/g, '').trim()} (${h})`)
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => '\n' + '#'.repeat(Number(n)) + ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ent[m])
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

export async function fetchPage(url, { allowPrivate = false, signal } = {}) {
  let cur = url;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(cur, allowPrivate);
    const res = await fetch(cur, {
      redirect: 'manual',
      headers: { 'user-agent': 'DiCode/1.0 (coding assistant)', accept: 'text/html,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.5' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { cur = new URL(res.headers.get('location'), cur).href; continue; }
    const type = res.headers.get('content-type') || '';
    const reader = res.body.getReader();
    const chunks = []; let n = 0;
    while (n < 3e6) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); n += value.length; }
    try { await reader.cancel(); } catch {}
    let body = Buffer.concat(chunks).toString('utf8');
    if (type.includes('html')) body = htmlToText(body);
    return { status: res.status, type, url: cur, body };
  }
  throw new Error('Too many redirects');
}

export async function webSearch(query, braveKey) {
  if (braveKey) {
    const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`, { headers: { 'x-subscription-token': braveKey, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Brave search ${r.status}`);
    const j = await r.json();
    return (j.web?.results || []).map((x) => ({ title: x.title, url: x.url, snippet: (x.description || '').replace(/<[^>]+>/g, '') }));
  }
  const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; DiCode/1.0)' }, signal: AbortSignal.timeout(15000) });
  const html = await r.text();
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 10) {
    let href = m[1];
    const u = /uddg=([^&]+)/.exec(href);
    if (u) href = decodeURIComponent(u[1]);
    out.push({ title: htmlToText(m[2]), url: href.startsWith('//') ? 'https:' + href : href, snippet: htmlToText(m[3]) });
  }
  return out;
}
