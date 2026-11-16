import {BridgeError} from '../router/common.js';
import {routeOf} from './experience-policy.js';

export class ConversationQueue {
  constructor(service) {
    this.service = service;
    this.store = service.store;
    this.policy = service.experience.policy.queue ?? {mode: 'independent', windowMs: 750, maxMessages: 5};
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS channel_batches(anchor_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_batch_members(source_id TEXT PRIMARY KEY,anchor_id TEXT NOT NULL);`);
  }
  anchor(id) {
    return this.store.db.prepare('SELECT anchor_id FROM channel_batch_members WHERE source_id=?').get(id)?.anchor_id ?? id;
  }
  child(id) { return this.anchor(id) !== id; }
  members(id) {
    const anchor = this.anchor(id);
    const row = this.store.db.prepare('SELECT payload FROM channel_batches WHERE anchor_id=?').get(anchor);
    return row ? this.store.open(row.payload, 'batch:' + anchor).members : [id];
  }
  text(row) {
    const members = this.members(row.id);
    if (this.child(row.id) || members.length < 2) return row.message.text;
    return members.map((id, index) => {
      const source = this.store.message(id);
      this.service.authorized(source, {allowExpired: true});
      return '[' + (index + 1) + '] ' + source.message.text;
    }).join('\n\n');
  }
  status(row) { return this.store.message(this.anchor(row.id))?.reply_state ?? row.reply_state; }
  assertWritable(id) {
    const anchor = this.anchor(id);
    if (anchor !== id) throw new BridgeError('This source belongs to a combined reply. Use its anchor message.',
      {status: 409, code: -32013, data: {reason: 'combined_reply', message_id: anchor}});
  }
  defer(row) {
    if (this.policy.mode !== 'batch' || row.message.control) return;
    this.store.db.prepare('UPDATE channel_messages SET event_next_at=? WHERE id=? AND event_state=\'pending\'')
      .run(row.created + this.policy.windowMs, row.id);
  }
  prepare() {
    const now = this.service.clock();
    this.store.db.prepare('DELETE FROM channel_batch_members WHERE anchor_id NOT IN (SELECT id FROM channel_messages)').run();
    this.store.db.prepare('DELETE FROM channel_batches WHERE anchor_id NOT IN (SELECT id FROM channel_messages)').run();
    this.syncOutcomes();
    if (this.policy.mode !== 'batch') return;
    const candidates = this.store.db.prepare("SELECT id FROM channel_messages WHERE event_state='pending' AND reply_state='none' AND expires>? ORDER BY created,rowid LIMIT 1000").all(now);
    const groups = new Map();
    for (const candidate of candidates) {
      const row = this.store.message(candidate.id);
      if (row.message.control || row.message.attachments.length || row.message.quote ||
          this.store.db.prepare('SELECT 1 FROM channel_batch_members WHERE source_id=?').get(row.id) ||
          this.store.db.prepare('SELECT 1 FROM dotbridge_tasks WHERE source_id=?').get(row.id) ||
          this.service.experience.get(row.id).phase !== 'received') continue;
      try { this.service.authorized(row); } catch { continue; }
      const key = routeOf(this.service.config, row.message).key;
      const rows = groups.get(key) ?? [];
      rows.push(row);
      groups.set(key, rows);
    }
    for (const rows of groups.values()) {
      const first = rows[0];
      if (first.created + this.policy.windowMs > now) continue;
      const selected = [];
      let length = 0;
      for (const row of rows) {
        if (selected.length >= this.policy.maxMessages || row.created > first.created + this.policy.windowMs ||
            length + row.message.text.length + 16 > 20000) break;
        selected.push(row);
        length += row.message.text.length + 16;
      }
      if (selected.length < 2) continue;
      const anchor = selected.at(-1), members = selected.map(row => row.id);
      this.store.tx(() => {
        for (const row of selected) {
          const current = this.store.message(row.id);
          if (current.reply_state !== 'none' || current.event_state !== 'pending' || this.child(row.id)) throw Error('Conversation queue changed.');
          this.store.db.prepare('INSERT INTO channel_batch_members VALUES (?,?)').run(row.id, anchor.id);
          if (row.id !== anchor.id) this.store.db.prepare("UPDATE channel_messages SET event_state='batched' WHERE id=?").run(row.id);
        }
        this.store.db.prepare('INSERT INTO channel_batches VALUES (?,?)')
          .run(anchor.id, this.store.seal({members}, 'batch:' + anchor.id));
        this.store.db.prepare('UPDATE channel_messages SET event_next_at=? WHERE id=?').run(now, anchor.id);
      });
    }
  }
  canDispatch(row) {
    if (this.policy.mode === 'independent') return true;
    const key = routeOf(this.service.config, row.message).key;
    const earlier = this.store.db.prepare("SELECT id FROM channel_messages WHERE rowid<? AND expires>? AND subscription_id=? AND reply_state IN ('none','pending','processing') AND event_state IN ('processing','delivered','uncertain') ORDER BY rowid LIMIT 1000")
      .all(row.accepted_order, this.service.clock(), row.subscription_id);
    const blocked = earlier.some(item => !this.child(item.id) && routeOf(this.service.config, this.store.message(item.id).message)?.key === key);
    if (blocked) this.store.db.prepare("UPDATE channel_messages SET event_next_at=? WHERE id=? AND event_state='pending'").run(this.service.clock() + 500, row.id);
    return !blocked;
  }
  syncOutcomes() {
    this.store.db.prepare(`UPDATE channel_messages SET reply_state=(SELECT anchor.reply_state FROM channel_batch_members member
      JOIN channel_messages anchor ON anchor.id=member.anchor_id WHERE member.source_id=channel_messages.id)
      WHERE id IN (SELECT source_id FROM channel_batch_members WHERE source_id<>anchor_id)
      AND EXISTS(SELECT 1 FROM channel_batch_members member JOIN channel_messages anchor ON anchor.id=member.anchor_id
        WHERE member.source_id=channel_messages.id AND anchor.reply_state<>'none')`).run();
  }
}
