const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');

const root = path.resolve(__dirname, '..');
const core = path.join(root, 'node_modules/@hydrooj/ui-default/templates');
class Loader extends nunjucks.FileSystemLoader {
  getSource(name) {
    if (name === 'layout/basic.html') return { src: '{% block content %}{% endblock %}', path: name };
    if (name === 'components/user.html') return { src: '{% macro render_inline(user) %}{{ user.uname }}{% endmacro %}', path: name };
    return super.getSource(name);
  }
}
// Render the real detail template and the native Hydro comment/reply macro.
// Only the unrelated outer layout and user badge component are stubbed.
const env = new nunjucks.Environment(new Loader([path.join(root, 'templates'), core]), { autoescape: true });
env.addFilter('json', JSON.stringify);
env.addFilter('markdown', (content) => `<p>${nunjucks.runtime.suppressValue(content, true)}</p>`);
const perm = Object.fromEntries([
  'PERM_LOCK_DISCUSSION', 'PERM_ADD_REACTION', 'PERM_REPLY_DISCUSSION',
  'PERM_DELETE_DISCUSSION_REPLY_SELF_DISCUSSION', 'PERM_DELETE_DISCUSSION_REPLY',
  'PERM_EDIT_DISCUSSION_REPLY_SELF', 'PERM_DELETE_DISCUSSION_REPLY_SELF',
].map((value) => [value, value]));

function state(options = {}) {
  const viewer = options.owner ? 42 : (options.signedIn ? 3 : null);
  const allowed = new Set(options.permissions || []);
  const ddoc = {
    _id: 'article-one', docId: 'article-one', owner: 42, title: '文章标题', content: '正文保持可读',
    views: 4, edited: Boolean(options.edited), lock: Boolean(options.lock), react: options.react || {},
  };
  const docs = options.comments ? [{
    _id: 'comment-one', docId: 'comment-one', parentId: ddoc.docId, owner: 42, content: '原评论',
    edited: true, reply: [{ _id: 'reply-one', owner: 42, content: '原回复', edited: true }],
  }] : [];
  return {
    ddoc, dsdoc: { star: Boolean(options.star) }, vnode: {}, drdocs: docs, drcount: docs.length,
    page: 1, pcount: 1, udict: { 42: { uname: '作者', avatar: '' }, 3: { uname: '读者', avatar: '' } },
    articleIsOwner: Boolean(options.owner), articleVisibility: options.visibility || 'public',
    articleShareUrl: '/article/article-one?share=fixture-share', articleAccessViaShare: false,
    model: { document: { TYPE_PROBLEM: 10 } }, perm, PRIV: { PRIV_USER_PROFILE: 'profile' }, Object,
    reactions: { 'article-one': { '👍': true }, 'comment-one': {} },
    handler: {
      csrfToken: 'fixture-csrf',
      user: {
        avatar: '', own: (doc) => viewer !== null && viewer === doc.owner,
        hasPriv: (privilege) => viewer !== null && privilege === 'profile',
        hasPerm: (permission) => allowed.has(permission),
      },
    },
    _: (value) => value, datetimeSpan: () => '刚刚', avatarUrl: () => '/fixture-avatar.png',
    user: { render_inline: (user) => user.uname },
    paginator: { render: () => '' }, nothing: { render: (text) => text },
    url: (name, args) => name === 'wiki_help' ? '/wiki/help#contact'
      : `/fixture/${name}/${args?.did || ''}${args?.drid ? `/${args.drid}` : ''}${args?.drrid ? `/${args.drrid}` : ''}`,
  };
}
function render(options) {
  return env.render('oi33_article_detail.html', state(options));
}
function footer(html) {
  return html.match(/<footer\b[^>]*class="oi33-article-paper__footer"[^>]*>([\s\S]*?)<\/footer>/)?.[1] || '';
}
function assertNoReport(html) {
  assert.doesNotMatch(html, /href="[^"]*(?:wiki\/help|#contact)|icon-warning|\bReport\b|举报/);
}

test('article report/contact shortcut is absent for visitors, readers, authors and managers', () => {
  for (const options of [
    {}, { edited: true }, { signedIn: true }, { owner: true },
    { signedIn: true, permissions: Object.values(perm) },
  ]) {
    const html = render(options);
    assertNoReport(html);
    assert.match(html, /正文保持可读/);
    assert.match(html, /讨论与补充/);
    assert.match(html, /还没有评论/);
  }
});

test('read-only unedited articles omit the empty footer, including zero-count reaction entries', () => {
  for (const react of [{}, { '👍': 0 }]) {
    const html = render({ react });
    assert.doesNotMatch(html, /<footer\b/);
    assert.doesNotMatch(html, /<ul class="supplementary dot list"/);
    assert.match(html, /oi33-article-comments/);
  }
});

test('edited articles keep the native history dropdown hook and raw-history URL', () => {
  for (const options of [{}, { signedIn: true }, { owner: true }]) {
    const html = render({ ...options, edited: true });
    assert.match(footer(html), /<li data-discussion-history data-raw-url="\/fixture\/discussion_raw\/article-one">Edited<\/li>/);
    assert.equal((footer(html).match(/data-discussion-history/g) || []).length, 1);
    assertNoReport(html);
  }
});

test('owner editing, share controls and lock/unlock actions retain their native forms and CSRF tokens', () => {
  for (const lock of [false, true]) {
    const html = render({ owner: true, lock, visibility: 'unlisted' });
    const actions = footer(html);
    assert.match(actions, /href="\/article\/article-one\/edit"/);
    assert.match(actions, /name="operation" value="set_lock"/);
    assert.match(actions, /Lock Topic/);
    assert.match(actions, /Unlock Topic/);
    if (lock) assert.doesNotMatch(actions, /name="lock" value="1"/);
    else assert.match(actions, /name="lock" value="1"/);
    for (const form of actions.match(/<form\b[\s\S]*?<\/form>/g) || []) {
      assert.match(form, /method="post"/);
      assert.match(form, /name="csrfToken" value="fixture-csrf"/);
    }
    assert.match(html, /文章管理/);
    assert.match(html, /data-article-copy-link="\/article\/article-one\?share=fixture-share"/);
    assert.match(html, /href="\/article\/mine"/);
  }
});

test('signed-in readers retain star/unstar without gaining author or moderation actions', () => {
  for (const star of [false, true]) {
    const html = render({ signedIn: true, star });
    const actions = footer(html);
    assert.match(actions, new RegExp(`name="operation" value="${star ? 'unstar' : 'star'}"`));
    assert.match(actions, /name="csrfToken" value="fixture-csrf"/);
    assert.doesNotMatch(html, /文章管理|编辑文章/);
    assert.doesNotMatch(actions, /set_lock|data-op="react"/);
  }
});

test('lock and reaction permissions still independently control their existing actions', () => {
  for (const permission of [perm.PERM_LOCK_DISCUSSION, perm.PERM_ADD_REACTION]) {
    const actions = footer(render({ signedIn: true, permissions: [permission] }));
    if (permission === perm.PERM_LOCK_DISCUSSION) {
      assert.match(actions, /name="operation" value="set_lock"/);
      assert.doesNotMatch(actions, /data-op="react"/);
    } else {
      assert.match(actions, /data-op="react" data-type="discuss"/);
      assert.match(actions, /&quot;nodeType&quot;:&quot;did&quot;/);
      assert.doesNotMatch(actions, /set_lock/);
    }
  }
});

test('existing reactions remain visible without edit/history or reaction-posting permission', () => {
  const html = render({ react: { '👍': 2, '👎': 0 } });
  const actions = footer(html);
  assert.match(actions, /class="reaction active"><span class="emoji">👍<\/span> 2/);
  assert.doesNotMatch(actions, /👎|data-op="react"|data-discussion-history/);
  assert.doesNotMatch(actions, /<ul class="supplementary dot list"/);
  assertNoReport(html);
});

test('native comment/reply creation and owner management remain rendered', () => {
  const html = render({ owner: true, comments: true, permissions: Object.values(perm) });
  assert.match(html, /原评论/);
  assert.match(html, /原回复/);
  assert.match(html, /name="operation" value="reply"/);
  for (const operation of ['tail_reply', 'edit_reply', 'delete_reply', 'edit_tail_reply', 'delete_tail_reply']) {
    assert.ok(html.includes(`&quot;operation&quot;:&quot;${operation}&quot;`), operation);
  }
  assert.match(html, /data-discussion-history data-raw-url="\/fixture\/discussion_reply_raw\/article-one\/comment-one"/);
  assert.match(html, /data-discussion-history data-raw-url="\/fixture\/discussion_tail_reply_raw\/article-one\/comment-one\/reply-one"/);
  assertNoReport(html);
});

test('read-only comments and locked discussions retain their existing permission boundaries', () => {
  const readOnly = render({ comments: true });
  assert.match(readOnly, /原评论/);
  assert.match(readOnly, /原回复/);
  assert.doesNotMatch(readOnly, /name="operation" value="reply"|data-op="(?:edit|delete|reply|react)"/);
  const locked = render({ signedIn: true, lock: true, permissions: [perm.PERM_REPLY_DISCUSSION] });
  assert.match(locked, /The discussion is locked, you can not reply anymore\./);
  assert.doesNotMatch(locked, /name="operation" value="reply"/);
});
