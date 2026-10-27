const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { ObjectId } = require('mongodb');

const hash = text => createHash('sha256').update(text.normalize('NFKC').toLowerCase()).digest('hex');

async function checkArticleUx({ db, check, actors, fixtureData }) {
  assert.match(db.databaseName, /^oi33_qa_\d+_\d+$/, 'Never run article mutation checks against production');
  const { student, outsider, admin, coach } = actors;
  const docs = db.collection('document'), moderation = db.collection('oi33_ai_moderation');
  const source = await docs.findOne({ domainId: 'system', docType: 21, docId: new ObjectId(fixtureData.articleId) });
  const did = new ObjectId(), drid = new ObjectId(), id = new ObjectId();
  const text = 'QA_PRIVATE_REJECTED_REPLY_ONLY_4';
  const revision = 'qa-initial-reply-revision';
  const topic = { ...source, _id: did, docId: did, owner: 2, title: 'QA feedback parent', content: 'Synthetic public parent',
    oi33Visibility: 'public', hidden: false, oi33ModerationPending: false, nReply: 1, lock: false };
  await docs.insertMany([topic, { _id: drid, docId: drid, domainId: 'system', docType: 22,
    parentType: 21, parentId: did, owner: 4, content: text, reply: [], hidden: true,
    oi33ModerationPending: true, oi33ModerationRejected: true, oi33ModerationRevision: revision }]);
  const entry = { _id: id, uid: 4, kind: 'reply', content: text, preview: text, contentHash: hash(text),
    targetRevision: revision, target: { domainId: 'system', drid }, verdict: 'block', source: 'ai',
    category: '隐私', aiReason: 'QA_ADMIN_ONLY_PROVIDER_REASON', status: 'done', createdAt: new Date() };
  await moderation.insertOne(entry);
  await db.collection('discussion.history').insertOne({ domainId: 'system', docId: drid, uid: 4,
    content: text, time: new Date(Date.now() - 60000) });
  const route = `/article/feedback/${id}`;
  const created = [did, drid], entryIds = [id];
  try {
    for (const [actor, role, expected] of [[student, 'student', '0'], [coach, 'coach', '1'], [admin, 'admin', '1']]) {
      const response = await actor('/article/new', null, { html: true });
      check(`article upload permission rendered before choosing a file: ${role}`, response.status === 200
        && (response.body.raw || '').includes(`data-article-upload="${expected}"`));
      check(`article draft scope carries actor and domain: ${role}`, /data-article-owner="system:\d+"/.test(response.body.raw || ''));
    }
    const compose = { title: 'QA successful draft receipt', content: 'Synthetic draft receipt content',
      problemId: '', visibility: 'private', highlight: 'false', pin: 'false' };
    const saved = await admin('/article/new', compose);
    check('normal article creation still succeeds', saved.status < 400 && !!saved.body.did);
    const savedId = new ObjectId(String(saved.body.did)); created.push(savedId);
    const savedPage = await admin(`/discuss/${savedId}`, null, { html: true });
    const expectedReceipt = createHash('sha256').update(JSON.stringify({ title: compose.title, content: compose.content,
      problemId: compose.problemId, visibility: compose.visibility })).digest('hex');
    check('successful POST yields an authenticated draft receipt for exactly submitted fields', savedPage.status === 200
      && (savedPage.body.raw || '').includes(`data-article-saved-fingerprint="${expectedReceipt}"`)
      && (savedPage.body.raw || '').includes('data-article-saved-id="new"') && /private/.test(savedPage.cache || ''));
    const repeatPage = await admin(`/discuss/${savedId}`, null, { html: true });
    check('successful draft receipt can be consumed only once', !(repeatPage.body.raw || '').includes('data-article-saved-id='));
    const own = await student(route);
    check('private feedback shows only the owner original text and safe status', own.status === 200
      && JSON.stringify(own.body).includes(text) && !JSON.stringify(own.body).includes(entry.aiReason)
      && /private/.test(own.cache || ''));
    for (const actor of [outsider, admin]) {
      const denied = await actor(route);
      check('feedback rejects another account including administrators', denied.status >= 400
        && !JSON.stringify(denied.body).includes(text));
    }
    const crossId = new ObjectId(); entryIds.push(crossId);
    await moderation.insertOne({ ...entry, _id: crossId, target: { domainId: 'qa_upload_other', drid } });
    const cross = await student(`/article/feedback/${crossId}`);
    check('feedback rejects a different domain entry', cross.status >= 400 && !JSON.stringify(cross.body).includes(text));
    const publicRead = await outsider(`/discuss/${did}`);
    check('blocked reply is not present in another student response', publicRead.status === 200
      && !JSON.stringify(publicRead.body).includes(text));
    const ownRead = await student(`/discuss/${did}`);
    check('blocked reply author gets a private feedback entry point', ownRead.status === 200
      && JSON.stringify(ownRead.body).includes('/article/feedback'));
    const body = { content: 'QA corrected algorithm explanation', revision };
    for (const visibility of ['private', 'unlisted']) {
      await docs.updateOne({ _id: did }, { $set: { oi33Visibility: visibility } });
      const denied = await student(route, body);
      check(`lost parent ${visibility} access prevents resubmission`, denied.status >= 400
        && (await docs.findOne({ _id: drid })).content === text);
    }
    await docs.updateOne({ _id: did }, { $set: { oi33Visibility: 'public', lock: true } });
    check('locked parent prevents resubmission', (await student(route, body)).status >= 400);
    await docs.updateOne({ _id: did }, { $set: { lock: false } });
    await docs.updateOne({ _id: drid }, { $set: { oi33ModerationRevision: 'qa-newer-edit' } });
    check('stale feedback cannot overwrite a newer reply revision', (await student(route, body)).status >= 400);
    await docs.updateOne({ _id: drid }, { $set: { oi33ModerationRevision: revision } });
    const cachedId = new ObjectId(); entryIds.push(cachedId);
    await moderation.insertOne({ ...entry, _id: cachedId, uid: 9999, content: body.content, contentHash: hash(body.content),
      target: undefined, targetRevision: undefined, verdict: 'pass', category: '正常', status: 'done' });
    const submitted = await student(route, body);
    check('owner can resubmit corrected reply through normal moderation', submitted.status < 400);
    let reviewed;
    for (let attempt = 0; attempt < 40; attempt++) {
      reviewed = await docs.findOne({ _id: drid });
      if (!reviewed.oi33ModerationPending) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    check('corrected reply becomes public only after its own passing verdict', reviewed.content === body.content
      && reviewed.hidden === false && reviewed.oi33ModerationPending === false);
    const tailId = new ObjectId(), tailSecret = 'QA_PRIVATE_TAIL_PARENT_BINDING';
    await docs.updateOne({ _id: drid }, { $set: { reply: [{ _id: tailId, owner: 4, content: tailSecret, hidden: false }] } });
    for (const visibility of ['private', 'unlisted']) {
      await docs.updateOne({ _id: did }, { $set: { oi33Visibility: visibility } });
      for (const suffix of ['', '?all=true', '?time=1']) {
        const forged = await outsider(`/discuss/${fixtureData.articleId}/${drid}/${tailId}/raw${suffix}`);
        check(`forged public topic ID cannot expose ${visibility} tail reply ${suffix}`, forged.status >= 400
          && !JSON.stringify(forged.body).includes(tailSecret));
      }
    }
    await docs.updateOne({ _id: did }, { $set: { oi33Visibility: 'public' } });
    for (const suffix of ['', '?all=true', '?time=1']) {
      const raw = await outsider(`/discuss/${did}/${drid}/raw${suffix}`);
      check(`approved reply raw/history never reveals the rejected previous version ${suffix}`,
        !JSON.stringify(raw.body).includes(text));
      if (suffix !== '?time=1') check(`approved current raw/history remains available ${suffix}`,
        raw.status === 200 && JSON.stringify(raw.body).includes(body.content));
    }
    const stale = await student(route, { content: 'QA stale overwrite', revision });
    check('old rejected record cannot change an approved replacement', stale.status >= 400
      && (await docs.findOne({ _id: drid })).content === body.content);
    const noReceipt = await student(`/discuss/${did}?article_saved=new`, null, { html: true });
    check('untrusted query does not claim successful draft submission', !(noReceipt.body.raw || '').includes('data-article-saved-id='));
  } finally {
    await docs.deleteMany({ _id: { $in: created } });
    await moderation.deleteMany({ $or: [{ _id: { $in: entryIds } }, { 'target.drid': drid }] });
    await db.collection('discussion.history').deleteMany({ domainId: 'system', docId: { $in: created } });
  }
}

module.exports = { checkArticleUx };
