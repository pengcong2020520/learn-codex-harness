// Pure, incremental SSE text parser. Keep state between UTF-8 decoded chunks.
export const sseState = (lastEventId = '') => ({ buffer: '', data: [], event: '', lastEventId, first: true, afterCR: false });
export function parseSse(previous, chunk) {
  const state = { ...previous, data: [...previous.data] }, events = [];
  if (state.first && chunk.length) { chunk = chunk.replace(/^\uFEFF/, ''); state.first = false; }
  const line = value => {
    if (value === '') {
      if (state.data.length) events.push({ data: state.data.join('\n'), id: state.lastEventId, event: state.event || 'message' });
      state.data = []; state.event = ''; return;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':'), field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'data') state.data.push(content);
    if (field === 'event') state.event = content;
    if (field === 'id' && !content.includes('\0')) state.lastEventId = content;
  };
  // CR, LF, and split CRLF all delimit lines, without inventing a blank frame.
  for (const char of chunk) {
    if (state.afterCR && char === '\n') { state.afterCR = false; continue; }
    state.afterCR = char === '\r';
    if (char === '\r' || char === '\n') { line(state.buffer); state.buffer = ''; }
    else state.buffer += char;
  }
  if (state.buffer.length + state.data.reduce((n, s) => n + s.length, 0) > 4 * 1024 * 1024) throw new Error('事件帧过大。');
  return { state, events };
}
