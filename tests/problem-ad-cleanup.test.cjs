const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const code = transformSync(fs.readFileSync(path.join(root, 'model/problem-ad-cleanup.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
const loaded = { exports: {} };
new Function('module', 'exports', code)(loaded, loaded.exports);
const { cleanupProblemAds } = loaded.exports;
const ad = '**本题来自洛谷编写教材《深入浅出程序设计竞赛 - 基础篇》**，并带有详细的教程和讲解，点击下列链接了解本书详情。[【官方网店绝赞热卖中！】>>>](https://item.taobao.com/item.htm?id=637730514783)';
const body = '## 题目描述\n小 A 有 $10$ 个苹果，输出剩余的数量。\n\n## 输入格式\n输入一个整数。\n\n## 输出格式\n输出答案。\n\n```input1\n2\n```\n\n```output1\n8\n```\n';
test('known advertisement-only background is removed including its heading, with body bytes preserved', () => {
  const content = `## 题目背景\n${ad}\n\n\n${body}`;
  const result = cleanupProblemAds(content);
  assert.equal(result.content, body);
  assert.equal(result.changed, true);
  assert.equal(result.removedParagraphs, 1);
  assert.equal(result.removedBackgrounds, 1);
  assert.deepEqual(result.languages, ['markdown']);
});
test('mixed background keeps the original heading and genuine paragraphs, deleting only the known ad', () => {
  const content = `## 题目背景\n\n小 A 是一名学生。\n\n${ad}\n\n他今天要分苹果。\n\n${body}`;
  const result = cleanupProblemAds(content);
  assert.equal(result.content, `## 题目背景\n\n小 A 是一名学生。\n\n他今天要分苹果。\n\n${body}`);
  assert.equal(result.removedBackgrounds, 0);
  assert.equal(result.removedParagraphs, 1);
});
test('all Chinese Markdown heading levels, closing markers and setext headings are supported', () => {
  for (const heading of ['# 题目背景', '## 题目背景 ##', '### **题目背景**', '#### 背景', '##### 题目背景', '###### 题目背景', '题目背景\n---', '题目背景\n===']) {
    assert.equal(cleanupProblemAds(`${heading}\n${ad}\n\n# 题目描述\n原文\n`).content, '# 题目描述\n原文\n', heading);
  }
});
test('CRLF and harmless soft line wrapping are supported without changing retained line endings', () => {
  const crlfBody = body.replaceAll('\n', '\r\n');
  const wrapped = ad.replace('，并带有', '，\r\n并带有');
  const result = cleanupProblemAds(`## 题目背景\r\n${wrapped}\r\n\r\n${crlfBody}`);
  assert.equal(result.content, crlfBody);
});
test('source attribution, legitimate purchasing stories and partial matches are preserved', () => {
  const paragraphs = [
    '本题来自洛谷编写教材《深入浅出程序设计竞赛 - 基础篇》。',
    '小 A 在官网网店购买了 3 本书，每本 20 元，请计算总价。',
    '[参考资料](https://item.taobao.com/item.htm?id=637730514783)',
    ad.replace('637730514783', '123456'),
    ad + ' 小 A 有 $10$ 个苹果，这也是求解所需的背景。',
    ad.replace('详细的教程和讲解', '重要题意：必须先读入 n'),
  ];
  for (const paragraph of paragraphs) {
    const content = `## 题目背景\n${paragraph}\n\n${body}`;
    assert.equal(cleanupProblemAds(content).content, content);
  }
});
test('matching words outside background, in samples, quoted text, fenced/indented code or HTML are never deleted', () => {
  const examples = [
    `## 题目描述\n${ad}\n`,
    `## 样例说明\n${ad}\n`,
    `## 题目背景\n> ${ad}\n\n${body}`,
    `\`\`\`markdown\n## 题目背景\n${ad}\n\`\`\`\n${body}`,
    `~~~markdown\n## 题目背景\n${ad}\n~~~\n${body}`,
    `## 题目背景\n\`\`\`text\n${ad}\n\`\`\`\n\n${body}`,
    `## 题目背景\n    ${ad}\n\n${body}`,
    `<!--\n## 题目背景\n${ad}\n-->\n${body}`,
    `## 题目背景\n<div>\n\n${ad}\n\n</div>\n${body}`,
  ];
  for (const content of examples) assert.equal(cleanupProblemAds(content).content, content);
  const html = `<h2>题目背景</h2><p>${ad}</p><h2>题目描述</h2><p>原文</p>`;
  assert.equal(cleanupProblemAds(html, { html: true }).content, html);
});
test('genuine child sections prevent removal of a background heading', () => {
  const content = `## 题目背景\n${ad}\n\n### 故事\n真实背景\n\n${body}`;
  const result = cleanupProblemAds(content);
  assert.equal(result.content, `## 题目背景\n### 故事\n真实背景\n\n${body}`);
  assert.equal(result.removedBackgrounds, 0);
});
test('multilingual JSON changes only matching language values and preserves other language content exactly', () => {
  const english = '## Background\nA student has 10 apples.\n\n```text\noriginal spacing  \n```\n';
  const content = JSON.stringify({ zh: `## 题目背景\n${ad}\n\n${body}`, en: english, 'zh-TW': '## 題目背景\n真實的故事。\n' }, null, 2);
  const result = cleanupProblemAds(content);
  assert.deepEqual(JSON.parse(result.content), { zh: body, en: english, 'zh-TW': '## 題目背景\n真實的故事。\n' });
  assert.deepEqual(result.languages, ['zh']);
  assert.equal(result.removedBackgrounds, 1);
});
test('no-match JSON remains byte-identical; nested/array/scalar payloads and HTML mode fail closed', () => {
  const noMatch = '{\n  "zh": "## 题目背景\\n真实背景。",\n  "en": "Statement"\n}';
  const weird = [
    noMatch, 'null', '123', JSON.stringify(`## 题目背景\n${ad}`),
    JSON.stringify([`## 题目背景\n${ad}`]),
    JSON.stringify({ zh: `## 题目背景\n${ad}`, metadata: { config: 'keep' } }),
  ];
  for (const content of weird) {
    const result = cleanupProblemAds(content);
    assert.equal(result.content, content); assert.equal(result.changed, false);
  }
  const markdown = `## 题目背景\n${ad}\n${body}`;
  assert.equal(cleanupProblemAds(markdown, { html: true }).content, markdown);
});
test('cleanup is idempotent for plain and multilingual statements, including multiple eligible sections', () => {
  const markdown = `## 题目背景\n${ad}\n\n${body}\n## 背景\n${ad}\n`;
  for (const content of [markdown, JSON.stringify({ zh: markdown, en: 'untouched' })]) {
    const first = cleanupProblemAds(content);
    const second = cleanupProblemAds(first.content);
    assert.equal(first.removedParagraphs, 2);
    assert.equal(second.content, first.content);
    assert.equal(second.changed, false);
    assert.equal(second.removedParagraphs, 0);
  }
});
