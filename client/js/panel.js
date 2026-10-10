import { h } from './common.js';

const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// The Game Feed: chat messages and server events in one chronological list (ordered by the
// server-assigned id). Rows are de-duplicated by id, so reconnect history never doubles up.
// Every new entry scrolls the feed to the bottom (after it has rendered). A "Scroll to bottom"
// button shows whenever you've scrolled up to read older entries.
export class GameFeed {
  constructor(root, { onSend }) {
    root.classList.add('side-panel');
    this.rows = new Map();
    this.scrollPending = false;
    this.list = h('div.feed-list', { role: 'log', 'aria-live': 'polite' });
    this.toBottomBtn = h('button.feed-new.hidden', { type: 'button', onclick: () => this.toBottom() }, 'Scroll to bottom');
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
    this.list.addEventListener('scroll', () => this.updateButton(), { passive: true });
    root.append(h('section.panel-section.feed', {}, h('h3', {}, 'Game Feed'), h('div.feed-wrap', {}, this.list, this.toBottomBtn), form));
  }

  atBottom() {
    return this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
  }

  updateButton() {
    this.toBottomBtn.classList.toggle('hidden', this.atBottom());
  }

  setHistory({ feed = [] }) {
    this.rows.clear();
    this.list.replaceChildren();
    this.add(feed);
  }

  add(rows) {
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
    if (added) this.toBottom();
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

  // Scroll after the new rows have rendered; a burst of rows coalesces into one scroll.
  toBottom() {
    if (this.scrollPending) return;
    this.scrollPending = true;
    requestAnimationFrame(() => {
      this.scrollPending = false;
      this.list.scrollTop = this.list.scrollHeight;
      this.updateButton();
    });
  }
}
