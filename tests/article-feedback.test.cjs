const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { transformSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
function load(relative, mocks = {}, suffix = '') {
  const code = transformSync(fs.readFileSync(path.join(root, relative), 'utf8') + suffix, {
    loader: 'ts', format: 'cjs', target: 'node18', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  }).code;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', code)(module, module.exports, name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name === 'crypto') return crypto;
    throw new Error(`Unexpected dependency: ${name}`);
  });
  return module.exports;
}
const hashOf = text => crypto.createHash('sha256').update(text).digest('hex');
const normalizeText = text => text.normalize('NFKC').toLowerCase();
const hashing = { hashOf, normalizeText };
const clone = value => JSON.parse(JSON.stringify(value));
const at = (doc, key) => key.split('.').reduce((value, part) => value?.[part], doc);
const matches = (doc, query) => Object.entries(query).every(([key, value]) => {
  const actual = at(doc, key);
  if (value?.$exists !== undefined) return (actual !== undefined) === value.$exists;
  if (value?.$ne !== undefined) return actual !== value.$ne;
  if (value?.$elemMatch) return actual?.some(item => matches(item, value.$elemMatch));
  return actual === value;
});
function fixture() {
  const docs = [], entries = [], routes = {}, decisions = [];
  const coll = {
    async findOne(query) { const doc = docs.find(d => matches(d, query)); return doc ? clone(doc) : null; },
    async updateOne(query, update) {
      const doc = docs.find(d => matches(d, query));
      if (!doc) return { matchedCount: 0 };
      for (const [key, value] of Object.entries(update.$set)) {
        if (key.startsWith('reply.$.')) doc.reply.find(item => matches(item, query.reply.$elemMatch))[key.slice(8)] = value;
        else doc[key] = value;
      }
      return { matchedCount: 1 };
    },
  };
  class ObjectId { constructor() { this.id = crypto.randomBytes(12).toString('hex'); } toHexString() { return this.id; } }
  class Handler {}
  class NotFoundError extends Error {}
  class ValidationError extends Error {}
  const hydro = {
    Handler, ObjectId, NotFoundError, ValidationError, ForbiddenError: Error,
    PERM: {}, PRIV: {}, Types: {}, param: () => () => {},
    DocumentModel: { coll, TYPE_DISCUSSION: 21, TYPE_DISCUSSION_REPLY: 22 },
    DiscussionModel: {}, MessageModel: { send() { throw new Error('No station messages allowed'); } }, UserModel: {},
  };
  const targetModel = load('model/moderation-target.ts', { hydrooj: hydro, './moderate': hashing });
  let nextVerdict = async () => 'block';
  const model = {
    aiGetConfig: async () => ({}), modFindCachedVerdict: async () => null, modTodayCost: async () => 0,
    modCountTodayByUid: async () => 0, aiAddUsage: async () => {},
    modAdd: async entry => { entries.push(clone(entry)); },
  };
  const moderate = load('handler/moderate.ts', {
    hydrooj: hydro, '../model': { oi33Model: model }, '../model/moderate': hashing,
    '../model/moderation-target': targetModel, './utils': { checkUserFlag: async () => 1, checkOi33Admin: async () => {} },
    './ai': { resolveChatConfig: async () => ({ apiKey: 'fixture-only', model: 'fixture' }), calcCost: () => 0,
      callChatCompletion: async () => ({ content: JSON.stringify({ verdict: await nextVerdict(), category: '隐私' }) }) },
  }, '\nexport { moderateAsync };');
  return { docs, entries, routes, decisions, hydro, model, targetModel, moderate, setVerdict: fn => { nextVerdict = fn; } };
}
function topic(content = 'first revision') {
  return { domainId: 'system', docType: 21, docId: 'topic1', owner: 4, title: 'Title', content,
    hidden: true, oi33ModerationPending: true };
}

test('block retains a hidden recoverable original without messages; an edited post is never deleted', async () => {
  const f = fixture(), target = { domainId: 'system', did: 'topic1' };
  f.docs.push(topic());
  await f.moderate.moderateAsync('topic', 4, 'Title\nfirst revision', target);
  assert.equal(f.docs[0].content, 'first revision');
  assert.equal(f.docs[0].hidden, true);
  assert.equal(f.docs[0].oi33ModerationRejected, true);
  assert.equal(f.entries[0].verdict, 'block');
  f.docs[0].content = 'edited revision';
  await f.moderate.moderateAsync('topic_edit', 4, 'Title\nedited revision', target);
  assert.equal(f.docs[0].content, 'edited revision');
  assert.equal(f.entries[1].verdict, 'review');
  assert.equal(f.entries[1].status, 'pending');
});

test('an old passing verdict cannot unhide or replace a newer edit', async () => {
  const f = fixture(), target = { domainId: 'system', did: 'topic1' };
  f.docs.push(topic());
  let release;
  f.setVerdict(() => new Promise(resolve => { release = resolve; }));
  const pending = f.moderate.moderateAsync('topic', 4, 'Title\nfirst revision', target);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  f.docs[0].content = 'new hidden revision';
  f.docs[0].oi33ModerationRevision = 'newer';
  release('pass'); await pending;
  assert.equal(f.docs[0].hidden, true);
  assert.equal(f.docs[0].content, 'new hidden revision');
  assert.equal(f.entries.length, 0);
});

test('same text with a different revision rejects an old review and deleted targets are never upserted', async () => {
  const f = fixture(), target = { domainId: 'system', did: 'topic1' };
  f.docs.push({ ...topic(), oi33ModerationRevision: 'v2' });
  assert.equal(f.targetModel.moderationTargetMatches(target, f.docs[0], {
    contentHash: hashOf('title\nfirst revision'), targetRevision: 'v1',
  }), false);
  assert.equal(f.targetModel.moderationTargetMatches(target, f.docs[0], {
    contentHash: hashOf('title\nfirst revision'),
  }), false, 'A legacy record without a revision cannot approve a newer target');
  const snapshot = clone(f.docs[0]); f.docs.length = 0;
  assert.equal(await f.targetModel.updateModerationTarget(target, snapshot, { hidden: false }), false);
  assert.equal(f.docs.length, 0);
});

test('tail-reply conditional update touches only the matching nested revision', async () => {
  const f = fixture(), target = { domainId: 'system', drid: 'reply1', drrid: 'tail1' };
  f.docs.push({ domainId: 'system', docType: 22, docId: 'reply1', content: 'parent', reply: [
    { _id: 'tail1', content: 'my content', oi33ModerationRevision: 'r1', hidden: true },
    { _id: 'tail2', content: 'other author', hidden: true },
  ] });
  const snapshot = await f.targetModel.readModerationTarget(target);
  assert.equal(await f.targetModel.updateModerationTarget(target, snapshot, { content: 'replacement' }), true);
  assert.equal(f.docs[0].reply[1].content, 'other author');
  assert.equal(await f.targetModel.updateModerationTarget(target, snapshot, { hidden: false }), false);
});

test('only one human decision can resolve a pending revision, including late snapshot reads', async () => {
  for (const firstApprove of [true, false]) {
    const f = fixture(), target = { domainId: 'system', did: 'topic1' };
    f.docs.push({ ...topic(), oi33ModerationRevision: 'v1', oi33ModerationRejected: false });
    const decide = (snapshot, approve) => f.targetModel.updateModerationTarget(target, snapshot, {
      hidden: !approve, oi33ModerationPending: !approve, oi33ModerationRejected: !approve,
    }, true);
    const old = clone(f.docs[0]);
    assert.equal(await decide(old, firstApprove), true);
    assert.equal(await decide(old, !firstApprove), false);
    assert.equal(await decide(clone(f.docs[0]), !firstApprove), false, 'A late snapshot must not revive an already handled entry');
    if (!firstApprove) assert.ok(f.targetModel.moderationTargetMatches(target, f.docs[0], {
      contentHash: hashOf('title\nfirst revision'), targetRevision: 'v1',
    }), 'Rejected content remains editable by its author through the matching record');
  }
});

test('real manual review handler protects history of legacy pending content without a marker', async () => {
  for (const action of ['approve', 'reject']) {
    const f = fixture();
    f.docs.push(topic());
    const entry = { _id: 'legacy', uid: 4, kind: 'topic', content: 'Title\nfirst revision',
      contentHash: hashOf('title\nfirst revision'), target: { domainId: 'system', did: 'topic1' }, status: 'pending' };
    f.model.modGet = async () => entry;
    f.model.modSetStatus = async (_id, status) => { entry.status = status; };
    f.hydro.DiscussionModel.get = async (domainId, docId) => f.docs.find(d => d.domainId === domainId && d.docId === docId);
    await f.moderate.apply({ on() {}, Route(name, _path, HandlerClass) { f.routes[name] = HandlerClass; } });
    const handler = new f.routes.oi33_ai_moderation();
    Object.assign(handler, { user: { _id: 2 }, response: {}, url: name => name });
    await handler.post('system', action, 'legacy');
    assert.equal(f.docs[0].oi33ModerationHistoryPrivate, true);
    assert.equal(f.docs[0].oi33ModerationPending, action === 'reject');
    assert.equal(entry.status, action === 'approve' ? 'approved' : 'rejected');
    assert.ok(f.targetModel.moderationTargetMatches(entry.target, f.docs[0], entry), 'Private author feedback remains bound to the original legacy revision');
  }
});

test('private feedback query excludes another account and domain before exposing content', async () => {
  const f = fixture();
  const record = { _id: 'entry', uid: 4, kind: 'reply', content: 'private original', target: { domainId: 'system' } };
  const feedback = load('handler/article-feedback.ts', {
    hydrooj: f.hydro, '../model/moderate': { moderationColl: { findOne: async query => matches(record, query) ? record : null } },
    '../model/moderation-target': f.targetModel, './moderate': f.moderate,
  });
  assert.equal(await feedback.ownFeedback('system', 5, 'entry'), null);
  assert.equal(await feedback.ownFeedback('other', 4, 'entry'), null);
  assert.equal((await feedback.ownFeedback('system', 4, 'entry')).content, 'private original');
});

test('successful draft receipt is actor/domain/destination bound, single use, and carries no content', () => {
  const api = load('handler/article-draft-receipt.ts');
  const h = { session: {}, user: { _id: 4 }, domain: { _id: 'system' } };
  const fields = { title: 'Title', content: 'private draft', problemId: '', visibility: 'private' };
  api.saveArticleDraftReceipt(h, 'new', 'topic1', fields);
  assert.equal(api.consumeArticleDraftReceipt(h, 'other'), null);
  const receipt = api.consumeArticleDraftReceipt(h, 'topic1');
  assert.deepEqual(Object.keys(receipt).sort(), ['fingerprint', 'source']);
  assert.equal(receipt.fingerprint, hashOf(JSON.stringify(fields)));
  assert.equal(api.consumeArticleDraftReceipt(h, 'topic1'), null);
  api.saveArticleDraftReceipt(h, 'new', 'topic1', fields);
  h.user._id = 5;
  assert.equal(api.consumeArticleDraftReceipt(h, 'topic1'), null);
  h.user._id = 4; api.saveArticleDraftReceipt(h, 'new', 'topic1', fields); h.domain._id = 'other';
  assert.equal(api.consumeArticleDraftReceipt(h, 'topic1'), null);
});

test('draft keys separate accounts, domains and articles; expired or malformed data is ignored', () => {
  const draft = load('frontend/article-draft.ts');
  const keys = ['system:4', 'system:5', 'other:4'].flatMap(owner => ['new', 'article'].map(id => draft.articleDraftKey(owner, id)));
  assert.equal(new Set(keys).size, 6);
  const payload = { version: 1, base: '{}', fields: { title: 't', content: 'c', problemId: '', visibility: 'private' }, savedAt: Date.now() };
  assert.ok(draft.parseArticleDraft(JSON.stringify(payload)));
  assert.equal(draft.parseArticleDraft('{malformed'), null);
  assert.equal(draft.parseArticleDraft(JSON.stringify({ ...payload, savedAt: 0 })), null);
});
