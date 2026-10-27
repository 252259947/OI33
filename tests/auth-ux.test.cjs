const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');
const root = path.resolve(__dirname, '..');
class Loader extends nunjucks.FileSystemLoader {
  getSource(name) {
    if (name.startsWith('layout/')) return { src: '{% block content %}{% endblock %}', path: name };
    return super.getSource(name);
  }
}
const env = new nunjucks.Environment(new Loader(path.join(root, 'templates')), {autoescape: true});
function context(smtpUser, verify = true, loggedIn = false) {
  return { _: s => Object.assign(new String(s), {format: () => s}),
    model: {system: {get: key => ({'smtp.user':smtpUser,'smtp.verify':verify,'server.login':true,'server.name':'OJ'})[key]}},
    handler: {user: {_id: loggedIn ? 17 : 0, hasPriv: key => key === 'register' || loggedIn, hasPerm: () => false}, csrfToken: 'csrf-fixture',
      loginMethods: [{id:'test',text:'OAuth'}], request: {path:'/p/1'}, domain:{ui:{name:'OJ'}}},
    PRIV:{PRIV_USER_PROFILE:'profile',PRIV_REGISTER_USER:'register'}, perm:{},
    url: (name, args) => `/${name}${args?.query?.redirect ? '?redirect='+encodeURIComponent(args.query.redirect) : ''}`,
    tdocs: [], groups: [], q:'', group:'', progress:'all', educationIsCoach:false,
    utils:{buildQueryString:()=>''} };
}
test('forgot-password page gives a concrete recovery path without SMTP, and retains mail reset with SMTP', () => {
  let html = env.render('user_lostpass.html', context(false));
  assert.match(html,/课程老师或 OJ 管理员/); assert.match(html,/用户名或 UID/);
  assert.match(html,/href="\/user_login"/); assert.doesNotMatch(html, /Relax|name="mail"/);
  html = env.render('user_lostpass.html', context('mailer'));
  assert.match(html,/name="mail" type="email"/); assert.match(html,/name="csrfToken" value="csrf-fixture"/);
});
test('registration copy follows the same SMTP verify switches as the native handler', () => {
  for (const [user,verify] of [[false,true],['mailer',false]]) {
    const html = env.render('user_register.html', context(user,verify));
    assert.match(html,/下一步设置用户名和密码/); assert.match(html,/value="下一步"/);
    assert.doesNotMatch(html,/我们会发送账号验证邮件/);
  }
  assert.match(env.render('user_register.html',context('mailer',true)),/我们会发送账号验证邮件/);
  assert.doesNotMatch(env.render('user_register_with_code.html',context(false)),/验证已经通过/);
});
test('page and popup login accept email in copy, preserve auth hooks, and link real recovery page', () => {
  for(const file of ['user_login.html','partials/login_dialog.html']) {
    const html=env.render(file,context(false));
    assert.match(html,/用户名或邮箱/); assert.match(html,/name="uname"/);
    assert.match(html,/name="tfa"/); assert.match(html,/name="authnChallenge"/);
    assert.match(html,/name="csrfToken"/); assert.match(html,/href="\/user_lostpass"/);
    assert.doesNotMatch(html,/data-lostpass/);
  }
});
test('anonymous homework shows login guidance, authenticated empty state still supports filters', () => {
  let html=env.render('homework_main.html',context(false));
  assert.match(html,/登录后查看你的作业/); assert.match(html,/redirect=%2Fhomework_main/);
  assert.doesNotMatch(html,/暂时没有可查看的作业|name="q"/);
  html=env.render('homework_main.html',context(false,true,true));
  assert.match(html,/暂时没有可查看的作业/); assert.match(html,/name="q"/);
  assert.doesNotMatch(html,/登录后查看你的作业/);
});
