const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const test = require('node:test');
const { transformSync } = require('esbuild');
const nunjucks = require('nunjucks');
const filters = require('nunjucks/src/filters');
const root = path.resolve(__dirname, '..');

// Load the installed Hydro renderer, including its actual KaTeX and XSS plugins.
// The temporary TypeScript loader is confined to this isolated test process.
const previousTsLoader = require.extensions['.ts'];
let markdown;
let ensureTag;
try {
    require.extensions['.ts'] = (mod, filename) => mod._compile(transformSync(fs.readFileSync(filename, 'utf8'), {
        loader: 'ts', format: 'cjs',
    }).code, filename);
    markdown = require('@hydrooj/ui-default/backendlib/markdown');
    ({ ensureTag } = require('@hydrooj/ui-default/backendlib/markdown-it-xss'));
} finally {
    if (previousTsLoader) require.extensions['.ts'] = previousTsLoader;
    else delete require.extensions['.ts'];
}
const helperFile = path.join(root, 'handler/article-excerpt.ts');
const helperModule = { exports: {} };
new Function('module', 'exports', 'require', '__filename', '__dirname', transformSync(fs.readFileSync(helperFile, 'utf8'), {
    loader: 'ts', format: 'cjs',
}).code)(helperModule, helperModule.exports, createRequire(helperFile), helperFile, path.dirname(helperFile));
const { articleExcerpt } = helperModule.exports;
const renderMarkdown = (source) => ensureTag(markdown.render(source));
const excerpt = (source) => articleExcerpt(renderMarkdown(source));
const occurrences = (text, value) => text.split(value).length - 1;

test('real Hydro KaTeX reproduces the triple text bug and the excerpt keeps one source formula', () => {
    const source = String.raw`有 $n$ 艘船。第 $i$ 艘船必须在 $[E_i,R_i]$ 内开始使用泊位，并连续占用 $L_i$ 个单位时间。`;
    const html = renderMarkdown(source);
    assert.match(html, /katex-mathml/);
    assert.match(html, /katex-html/);
    assert.match(html, /annotation encoding="application\/x-tex"/);
    assert.match(filters.striptags(html), /nnn/);
    const text = articleExcerpt(html);
    assert.equal(text, '有 n 艘船。第 i 艘船必须在 [E_i,R_i] 内开始使用泊位，并连续占用 L_i 个单位时间。');
    for (const formula of ['[E_i,R_i]', 'L_i']) assert.equal(occurrences(text, formula), 1);
    assert.doesNotMatch(text, /katex|annotation|mathnormal|nnn/);
});

test('fractions, square roots, subscripts and matrices retain their TeX meaning exactly once', () => {
    const formulas = [String.raw`\frac{a}{b}`, String.raw`\sqrt{x^2+1}`, 'x_i^2',
        String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`];
    for (const formula of formulas) {
        const html = renderMarkdown(`前 $${formula}$ 后`);
        assert.match(html, /class="katex"/);
        assert.equal(articleExcerpt(html), `前 ${formula} 后`);
    }
});

test('block math is flattened once and whitespace is normalized without losing TeX commands', () => {
    const formula = String.raw`\frac{a}{b} + \sqrt{x}`;
    assert.equal(excerpt(`前文\n\n$$\n${formula}\n$$\n\n后文`), `前文 ${formula} 后文`);
    assert.equal(excerpt('$$\n a   +\n b \n$$'), 'a + b');
});

test('inline and fenced code keep literal dollar signs and are not mistaken for formula markup', () => {
    const source = '代码 `$n$` 和 `a < b`。\n\n```cpp\ncout << "$n$";\n```';
    const html = renderMarkdown(source);
    assert.doesNotMatch(html, /class="katex"/);
    const text = articleExcerpt(html);
    assert.equal(occurrences(text, '$n$'), 2);
    assert.ok(text.includes('a < b'));
    assert.ok(text.includes('cout << "$n$";'));
});

test('long formulas and invalid or unmatched math remain readable and never crash', () => {
    const longFormula = Array.from({ length: 24 }, (_, index) => `x_${index}`).join('+');
    const longHtml = renderMarkdown(`前 $${longFormula}$ 后`);
    assert.doesNotMatch(longHtml, /class="katex"/); // Hydro defers formulas longer than 50 characters.
    assert.equal(occurrences(articleExcerpt(longHtml), longFormula), 1);
    for (const formula of [String.raw`\notacommand{x}`, String.raw`\frac{a}`, 'a_{']) {
        const text = excerpt(`前 $${formula}$ 后`);
        assert.ok(text.includes(formula), `${formula}: ${text}`);
        assert.equal(occurrences(text, formula), 1);
    }
    assert.equal(excerpt('未闭合 $n 和价格 $5'), '未闭合 $n 和价格 $5');
});

test('missing math annotations have a short neutral fallback, not duplicated visual nodes', () => {
    const html = '<p>前 <span class="katex"><span>visual</span><span>duplicate</span></span> 后</p>';
    assert.equal(articleExcerpt(html), '前 [公式] 后');
    assert.equal(articleExcerpt(''), '');
    assert.equal(articleExcerpt('<p> \n\t </p>'), '');
});

test('ordinary Markdown, links, lists and entities still yield compact plain text', () => {
    const text = excerpt('# 学习笔记\n\n**重点** 与 *说明*、[题目](https://example.test/problem)\n\n- 第一项\n- 第二项\n\nA &amp; B &lt; C');
    for (const value of ['学习笔记', '重点', '说明', '题目', '第一项', '第二项', 'A & B < C']) assert.ok(text.includes(value), value);
    assert.doesNotMatch(text, /<\/?(?:p|h1|a|em|strong|ul|li)\b|\n|\s{2}/);
});

test('script/style bodies are excluded, while decoded hostile entities remain plain text for autoescape', () => {
    assert.equal(articleExcerpt('<script>SECRET_SCRIPT</script><style>SECRET_STYLE</style><p>正常</p>'), '正常');
    const encoded = '&lt;img src=x onerror=alert(1)&gt; &amp; &lt;script&gt;SECRET&lt;/script&gt;';
    const text = excerpt(encoded);
    assert.ok(text.includes('<img src=x onerror=alert(1)>'));
    assert.ok(text.includes('<script>SECRET</script>'));
    assert.doesNotMatch(text, /&lt;|&amp;/);
});

class Loader extends nunjucks.FileSystemLoader {
    getSource(name) {
        const stubs = {
            'layout/basic.html': '{% block content %}{% endblock %}',
            'components/user.html': '{% macro render_inline(user, badge) %}USER{% endmacro %}',
            'components/paginator.html': '{% macro render(page, count) %}{% endmacro %}',
        };
        if (Object.hasOwn(stubs, name)) return { src: stubs[name], path: name };
        return super.getSource(name);
    }
}
const env = new nunjucks.Environment(new Loader(path.join(root, 'templates')), { autoescape: true });
env.addFilter('markdown', renderMarkdown);
function templateState(content) {
    return {
        ddocs: [{ _id: 'article-one', docId: 'article-one', owner: 3, title: '文章标题', content,
            oi33Kind: 'article', oi33Visibility: 'public', parentType: 2, parentId: 'oi33-articles-internal',
            views: 1, nReply: 0, updateAt: new Date('2026-09-08T00:00:00Z') }],
        vnode: {}, vndict: {}, articlePdict: {}, udict: { 3: { uname: 'author' } },
        model: { document: { TYPE_DISCUSSION_NODE: 2, TYPE_PROBLEM: 10, TYPE_CONTEST: 30 }, discussion: { typeDisplay: {} } },
        handler: { oi33ArticleExcerpt: articleExcerpt, user: { hasPerm: () => true, hasPriv: () => true, realname_flag: 1 } },
        perm: { PERM_CREATE_DISCUSSION: 1n }, PRIV: { PRIV_USER_PROFILE: 1 },
        _: (value) => value, datetimeSpan: () => '刚刚', url: () => '/discuss/article-one',
    };
}
const templates = ['partials/oi33_discussion_list.html', 'oi33_article_mine.html'];
function extractParagraph(html, template) {
    const pattern = template === templates[0] ? /<p class="oi33-discuss__excerpt">([^]*?)<\/p>/
        : /<h2><a class="oi33-article-mine__primary-link"[^]*?<\/h2>\s*<p>([^]*?)<\/p>/;
    const match = html.match(pattern);
    assert.ok(match, `excerpt paragraph in ${template}`);
    return match[1];
}

test('both actual article templates use the helper and retain their existing 150/180 excerpt limits', () => {
    const source = `先看 $n$，${'内容 '.repeat(150)}末尾不可见`;
    for (const [index, template] of templates.entries()) {
        const html = env.render(template, templateState(source));
        const text = extractParagraph(html, template);
        const expected = filters.truncate(excerpt(source), index ? 180 : 150);
        assert.equal(text, expected);
        assert.match(text, /^先看 n，/);
        assert.match(text, /\.\.\.$/);
        assert.doesNotMatch(text, /末尾不可见|nnn|katex/);
    }
});

test('both actual templates autoescape decoded HTML and unsafe TeX text rather than introducing tags', () => {
    const source = '&lt;img src=x onerror=alert(1)&gt; $a<b$ &amp; &lt;script&gt;x&lt;/script&gt;';
    for (const template of templates) {
        const html = env.render(template, templateState(source));
        const paragraph = extractParagraph(html, template);
        assert.ok(paragraph.includes('&lt;img src=x onerror=alert(1)&gt;'));
        assert.ok(paragraph.includes('a&lt;b'));
        assert.ok(paragraph.includes('&lt;script&gt;x&lt;/script&gt;'));
        assert.doesNotMatch(html, /<img\b|<script\b/);
    }
});

test('extracting many excerpts leaves the shared Hydro renderer and full article math unchanged', () => {
    const source = String.raw`正文 $\frac{a}{b}+\sqrt{x}$ 与 $n$。`;
    const before = renderMarkdown(source);
    const inlineRule = markdown.md.renderer.rules.math_inline;
    const blockRule = markdown.md.renderer.rules.math_block;
    for (let index = 0; index < 5; index += 1) {
        assert.ok(articleExcerpt(before).includes(String.raw`\frac{a}{b}+\sqrt{x}`));
        excerpt('$$a+b$$');
    }
    assert.equal(markdown.md.renderer.rules.math_inline, inlineRule);
    assert.equal(markdown.md.renderer.rules.math_block, blockRule);
    assert.equal(renderMarkdown(source), before);
    assert.match(before, /katex-mathml/);
    assert.match(before, /katex-html/);
});
