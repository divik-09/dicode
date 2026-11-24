/** Minimal Server-Sent Events parser over a fetch() body. Yields { event, data } objects. */
export async function* sse(body) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      const ev = { event: 'message', data: '' };
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) ev.event = line.slice(6).trim();
        else if (line.startsWith('data:')) ev.data += (ev.data ? '\n' : '') + line.slice(5).replace(/^ /, '');
      }
      if (ev.data) yield ev;
    }
  }
}
