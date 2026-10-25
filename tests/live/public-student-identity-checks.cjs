// Real HTTP checks against synthetic accounts in hydro-smoke's random database.
// Names in the fixture deliberately differ across username, real name and alias.
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');

function userLinks(html, uid) {
  return [...html.matchAll(/<a\b[^>]*href="[^"#]*\/user\/(\d+)(?:[?#][^"]*)?"[^>]*>([\s\S]*?)<\/a>/g)]
    .filter(match => Number(match[1]) === uid)
    .map(match => match[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
}

async function checkPublicStudentIdentity({ db, check, actors, fixtureData, session, login, report }) {
  assert.match(db.databaseName, /^oi33_qa_\d+_\d+$/, 'Synthetic checks must never use a production database');
  const { student, admin } = actors;
  const expected = { 12: 'qa_public_name', 13: 'qa_identity_13@example.test', 14: 'qa_pending_name', 15: 'QA_SAME_NAME' };
  const snapshot = async () => {
    const users = await db.collection('user').find({ _id: { $in: [12, 13, 14, 15] } },
      { projection: { _id: 1, uname: 1, unameLower: 1, mail: 1, hash: 1, salt: 1, priv: 1 } }).sort({ _id: 1 }).toArray();
    const names = await db.collection('oi33_user').find({ _id: { $in: [12, 13, 14, 15] } },
      { projection: { _id: 1, realname_name: 1, realname_flag: 1 } }).sort({ _id: 1 }).toArray();
    return createHash('sha256').update(JSON.stringify({ users, names })).digest('hex');
  };
  const before = await snapshot();
  const identityRoutes = [
    ['/', [12, 13, 14, 15]],
    ['/ranking', [12, 13, 14, 15]],
    ['/oi33/at-cf-rating?sort=atcoder', [12, 13, 14, 15]],
    ['/oi33/at-cf-rating?sort=codeforces', [12, 13, 14, 15]],
    ['/discuss', [12]],
    [`/discuss/problem/${fixtureData.pid}`, [12]],
    [`/discuss/${fixtureData.identityArticleId}`, [12, 13, 14, 15]],
  ];
  for (const [route, uids] of identityRoutes) {
    for (const html of [true, false]) {
      const result = await student(route, null, { html });
      const content = html ? result.body.raw || '' : JSON.stringify(result.body);
      check(`student ${html ? 'HTML' : 'JSON'} renders public identity ${route}`, result.status === 200,
        `status ${result.status}; ${result.status === 200 ? '' : content.slice(-1200)}`);
      check(`student ${html ? 'HTML' : 'JSON'} hides separate real names and aliases ${route}`,
        !/QA_PRIVATE_REALNAME_|QA_PRIVATE_DISPLAYNAME_/.test(content));
      check(`student ${html ? 'HTML' : 'JSON'} does not expose named users registration email ${route}`,
        !/qa_identity_(?:12|14|15)@example\.test/.test(content));
      for (const uid of uids) {
        check(`student ${html ? 'HTML' : 'JSON'} username/fallback UID ${uid} ${route}`,
          html ? userLinks(content, uid).some(name => name.includes(expected[uid])) : content.includes(expected[uid]));
      }
      check(`student identity response is private ${route}`, /private/.test(result.cache || ''));
    }
  }
  for (const uid of [12, 13, 14, 15]) {
    for (const html of [true, false]) {
      const result = await student(`/user/${uid}`, null, { html });
      const content = html ? result.body.raw || '' : JSON.stringify(result.body);
      check(`student profile ${uid} ${html ? 'HTML' : 'JSON'} displays username or fallback`,
        result.status === 200 && content.includes(expected[uid]), `status ${result.status}`);
      check(`student profile ${uid} hides separate real name and alias`, !/QA_PRIVATE_REALNAME_|QA_PRIVATE_DISPLAYNAME_/.test(content));
      if (uid !== 13) check(`student profile ${uid} hides non-fallback email`, !content.includes(`qa_identity_${uid}@example.test`));
    }
  }
  const self = session();
  await login(self, 'qa_public_name');
  const ownProfile = await self('/user/12', null, { html: true });
  const ownHtml = ownProfile.body.raw || '';
  const title = ownHtml.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1] || '';
  check('student own profile heading contains username without display-name alias', ownProfile.status === 200
    && title.includes(expected[12]) && !/QA_PRIVATE_REALNAME_|QA_PRIVATE_DISPLAYNAME_/.test(title));
  const ownArticles = await self('/article/mine', null, { html: true });
  check('student own article list keeps username and hides separate real names', ownArticles.status === 200
    && (ownArticles.body.raw || '').includes(expected[12]) && !/QA_PRIVATE_REALNAME_|QA_PRIVATE_DISPLAYNAME_/.test(ownArticles.body.raw || ''));
  const privileged = await admin('/user/12', null, { html: true });
  check('administrator retains approved real-name profile visibility', privileged.status === 200
    && (privileged.body.raw || '').includes('QA_PRIVATE_REALNAME_12'));
  const rankingAfterAdmin = await student('/ranking', null, { html: true });
  check('administrator visit cannot contaminate later student identity rendering', rankingAfterAdmin.status === 200
    && !/QA_PRIVATE_REALNAME_|QA_PRIVATE_DISPLAYNAME_/.test(rankingAfterAdmin.body.raw || ''));
  check('public identity rendering leaves usernames emails passwords permissions and verified names unchanged', before === await snapshot());
  report.studentIdentity = { realStudentSessions: true, productionAccountsUsed: false,
    profiles: [12, 13, 14, 15], ranking: true, discussionList: true, discussionDetailAndReplies: true,
    usernameFallback: true, usernamesEqualToRealNamePreserved: true };
}
module.exports = { checkPublicStudentIdentity };
