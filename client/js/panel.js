import { h } from './common.js';

const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// The Game Feed: chat messages and server events in one chronological list (ordered by the
// server-assigned id). Rows are de-duplicated by id, so reconnect history never doubles up.
// Auto-scrolls only when you were already at the bottom; otherwise shows a "new" pill.
export class GameFeed {
  constructor(root, { onSend }) {
    root.classList.add('side-panel');
    this.rows = new Map();
    this.unseen = 0;
    this.list = h('div.feed-list', { role: 'log', 'aria-live': 'polite' });
    this.pill = h('button.feed-new.hidden', { type: 'button', onclick: () => this.toBottom() });
    this.input = h('input', { type: 'text', placeholder: 'Message… (/roll 2d6)', maxLength: 500, 'aria-label': 'Chat message' });
    const form = h('form.chat-form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const text = this.input.value.trim();
        if (!text) return;
        this.input.value = '';
        await onSend(text);
      },
    }, this.input, h('button.small', { type: 'submit' }, 'Send'));
    this.list.addEventListener('scroll', () => { if (this.atBottom()) this.clearUnseen(); });
    root.append(h('section.panel-section.feed', {}, h('h3', {}, 'Game Feed'), h('div.feed-wrap', {}, this.list, this.pill), form));
  }

  atBottom() {
    return this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
  }

  setHistory({ feed = [] }) {
    this.rows.clear();
    this.list.replaceChildren();
    this.add(feed, { history: true });
  }

  add(rows, { history = false } = {}) {
    const stick = history || this.atBottom();
    let added = 0;
    for (const r of rows) {
      if (this.rows.has(r.id)) continue;
      this.rows.set(r.id, r);
      const el = this.render(r);
      // Keep server order even if a late row arrives out of sequence.
      const after = [...this.list.children].find((c) => Number(c.dataset.id) > r.id);
      this.list.insertBefore(el, after ?? null);
      added++;
    }
    while (this.list.children.length > 500) {
      this.rows.delete(Number(this.list.firstChild.dataset.id));
      this.list.firstChild.remove();
    }
    if (!added) return;
    if (stick) this.toBottom();
    else {
      this.unseen += added;
      this.pill.textContent = `↓ ${this.unseen} new`;
      this.pill.classList.remove('hidden');
    }
  }

  render(r) {
    const cls = r.kind === 'chat' ? 'feed-row.chat' : `feed-row.event.type-${r.type}${r.dmOnly ? '.dm-only' : ''}`;
    const el = h(`div.${cls}`, { dataset: { id: r.id }, style: { '--accent': r.color || '#888' } }, h('span.ts', {}, time(r.ts)));
    if (r.kind === 'chat') el.append(h('span.who', { style: { color: r.color } }, r.name), h('span.text', {}, r.text));
    else {
      if (r.dmOnly) el.append(h('span.dm-tag', { title: 'Only the DM sees this' }, 'DM'));
      el.append(h('span.text', {}, r.text));
    }
    return el;
  }

  toBottom() {
    requestAnimationFrame(() => {
      this.list.scrollTop = this.list.scrollHeight;
      this.clearUnseen();
    });
  }

  clearUnseen() {
    this.unseen = 0;
    this.pill.classList.add('hidden');
  }
}
