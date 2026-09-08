const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');
const { transformSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const coreTemplates = path.join(root, 'node_modules/@hydrooj/ui-default/templates');
const templateBackend = fs.readFileSync(path.join(root, 'node_modules/@hydrooj/ui-default/backendlib/template.ts'), 'utf8');
// Use Hydro's actual member lookup, including its special handling of .call.
const memberLookup = templateBackend.match(/nunjucks\.runtime\.memberLookup = function memberLookup[\s\S]*?\n};/)[0];
new Function('nunjucks', memberLookup)(nunjucks);
const env = new nunjucks.Environment(new nunjucks.FileSystemLoader([
  path.join(root, 'templates'), coreTemplates,
]), { autoescape: true });
const source = fs.readFileSync(path.join(root, 'templates/partials/homework_sidebar.html'), 'utf8');
const contestSource = fs.readFileSync(path.join(root, 'node_modules/hydrooj/src/model/contest.ts'), 'utf8');
const functions = ['canViewHiddenScoreboard', 'canShowScoreboard'].map((name) =>
  contestSource.match(new RegExp(`export function ${name}\\b[\\s\\S]*?(?=\\nexport )`))[0],
).join('\n');
const compiled = transformSync(functions, { loader: 'ts', format: 'cjs', target: 'node18' }).code;
const perm = {
  PERM_ATTEND_HOMEWORK: 1n,
  PERM_READ_RECORD_CODE: 2n,
  PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD: 4n,
  PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD: 8n,
};

function context({ publicScoreboard = false, owns = false, permissions = 0n } = {}) {
  const tdoc = { docId: 'homework', rule: 'homework', pids: [], beginAt: new Date(0), penaltySince: new Date(3600000), endAt: new Date(7200000) };
  const user = {
    own: (doc) => { assert.equal(doc, tdoc); return owns; },
    hasPerm: (permission) => (permissions & permission) === permission,
    hasPriv: () => false,
  };
  const loaded = { exports: {} };
  new Function('module', 'exports', 'PERM', 'RULES', compiled)(loaded, loaded.exports, perm, {
    // Built-in homework currently always shows the scoreboard. Exercise the
    // hidden branch explicitly so future rule changes cannot revive this bug.
    homework: { showScoreboard: () => publicScoreboard },
  });
  return {
    page_name: 'homework_detail', tdoc, tsdoc: { attend: true }, handler: { user }, perm,
    PRIV: { PRIV_USER_PROFILE: 1, PRIV_READ_RECORD_CODE: 2 },
    model: { contest: { ...loaded.exports, isDone: () => true, statusText: () => 'Ended' } },
    _: (value) => value, url: (name) => `/${name}`, datetimeSpan: (value) => value.toISOString(),
  };
}

test('homework sidebar uses the actual Hydro receiver and tdoc for hidden-scoreboard checks', () => {
  const state = context({ permissions: perm.PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD });
  const html = env.renderString(source, state);
  assert.match(html, /Scoreboard \(Hidden\)/);
  const previous = source.replace('canViewHiddenScoreboard.call(handler, tdoc)', 'canViewHiddenScoreboard(handler, tdoc)');
  assert.notEqual(previous, source);
  assert.throws(() => env.renderString(previous, state), /own/);
});

test('hidden scoreboard remains unavailable without owner or native Hydro permission', () => {
  const denied = env.renderString(source, context());
  assert.doesNotMatch(denied, /href="\/homework_scoreboard"/);
  const owner = env.renderString(source, context({ owns: true }));
  assert.match(owner, /Scoreboard \(Hidden\)/);
});

test('built-in public homework scoreboard keeps its ordinary link', () => {
  const html = env.renderString(source, context({ publicScoreboard: true }));
  assert.match(html, /href="\/homework_scoreboard"/);
  assert.doesNotMatch(html, /Scoreboard \(Hidden\)/);
});
