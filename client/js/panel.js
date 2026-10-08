import { h } from './common.js';

const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Right-side panel with two separate areas: player chat and the server-generated activity log.
export class SidePanel {
  constructor(root, { onSend }) {
    root.classList.add('side-panel');
    this.chatList = h('div.chat-list');
    this.activityList = h('div.activity-list');
    this.input = h('input', { type: 'text', placeholder: 'Message… (/roll 2d6)', maxLength: 500 });
    const form = h('form.chat-form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const text = this.input.value.trim();
        if (!text) return;
        this.input.value = '';
        await onSend(text);
      },
    }, this.input, h('button.small', { type: 'submit' }, 'Send'));
    root.append(
      h('section.panel-section.chat', {}, h('h3', {}, 'Chat'), this.chatList, form),
      h('section.panel-section.activity', {}, h('h3', {}, 'Activity'), this.activityList),
    );
  }

  setHistory({ chat, activity }) {
    this.chatList.replaceChildren();
    this.activityList.replaceChildren();
    this.addChat(chat);
    this.addActivity(activity);
  }

  addChat(rows) {
    for (const m of rows) {
      this.chatList.append(h('div.chat-msg', {},
        h('span.ts', {}, time(m.ts)),
        h('span.who', { style: { color: m.color } }, m.name),
        h('span.text', {}, m.text)));
    }
    this.scroll(this.chatList);
  }

  addActivity(rows) {
    for (const r of rows) {
      this.activityList.append(h(`div.activity.type-${r.type}`, { style: { '--accent': r.color || '#888' } },
        h('span.ts', {}, time(r.ts)), h('span.text', {}, r.text)));
    }
    while (this.activityList.children.length > 400) this.activityList.firstChild.remove();
    this.scroll(this.activityList);
  }

  scroll(list) {
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }
}
