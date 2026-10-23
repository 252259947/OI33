const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('esbuild');
const { parseDocument } = require('htmlparser2');
const { textContent, getOuterHTML, prependChild } = require('domutils');

const source = fs.readFileSync(path.join(__dirname, '../frontend/problem-samples.ts'), 'utf8');
const compiled = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
const moduleUnderTest = { exports: {} };
new Function('module', 'exports', compiled)(moduleUnderTest, moduleUnderTest.exports);
const { discoverSampleBlocks } = moduleUnderTest.exports;

// Adapt only the read-only DOM surface used by the parser. HTML is parsed by
// the existing html-to-text dependency's HTML parser, without a browser.
function dom(html) {
    const root = parseDocument(html);
    const adapt = (node) => {
        Object.defineProperty(node, 'textContent', { get: () => textContent(node), configurable: true });
        if (node.type === 'tag') {
            Object.defineProperty(node, 'tagName', { get: () => node.name.toUpperCase(), configurable: true });
            Object.defineProperty(node, 'className', { get: () => node.attribs.class || '', configurable: true });
        }
        for (const child of node.children || []) adapt(child);
    };
    adapt(root);
    return root;
}
const pre = (id, language = 'text', value = id) => `<pre><code id="${id}"${language ? ` class="language-${language}"` : ''}>${value}</code></pre>`;
const snapshot = (blocks) => blocks.map((block) => [block.id, block.kind, block.code.attribs.id, block.native]);

test('native numbered and unnumbered samples survive Prism wrappers and generated headings', () => {
    const html = `<div class="richmedia"><div class="row"><div class="code-toolbar sample"><h2>输入数据 1</h2>${pre('in', 'input1')}<div class="toolbar">Copy</div></div>`
        + `<div class="code-toolbar sample"><h2>输出数据 1</h2>${pre('out', 'output1')}<div class="toolbar">Copy</div></div></div></div>`;
    assert.deepEqual(snapshot(discoverSampleBlocks(dom(html))), [['1', 'input', 'in', true], ['1', 'output', 'out', true]]);
    assert.deepEqual(snapshot(discoverSampleBlocks(dom(pre('in', 'input') + pre('out', 'output')))),
        [['1', 'input', 'in', true], ['1', 'output', 'out', true]]);
    assert.deepEqual(snapshot(discoverSampleBlocks(dom(pre('out', 'output1') + pre('in', 'input1')))),
        [['1', 'output', 'out', true], ['1', 'input', 'in', true]], 'Explicit markers can appear in either DOM order');
});

test('Luogu-style sample headings and labels identify paired text blocks without touching payloads', () => {
    const root = dom('<div class="richmedia"><h2>样例 1</h2><p><strong>输入：</strong></p>'
        + pre('in', 'text', '1  2\t3\n\n 4\n') + '<p>输出:</p>' + pre('out', 'text', '&lt;x&gt; &amp; 9\n') + '</div>');
    const before = getOuterHTML(root);
    const blocks = discoverSampleBlocks(root);
    assert.deepEqual(snapshot(blocks), [['1', 'input', 'in', false], ['1', 'output', 'out', false]]);
    assert.equal(blocks[0].code.textContent, '1  2\t3\n\n 4\n');
    assert.equal(blocks[1].code.textContent, '<x> & 9\n');
    assert.equal(blocks[0].scope, blocks[1].scope);
    assert.equal(getOuterHTML(root), before);
    assert.deepEqual(snapshot(discoverSampleBlocks(root)), snapshot(blocks), 'Repeated discovery is pure and stable');
});

test('Chinese and English standalone sample role headings pair explicit numbers', () => {
    for (const [input, output] of [['输入样例 2', '输出样例 2'], ['样例输入 #2', '样例输出 #2'],
        ['Sample Input 2', 'Sample Output 2'], ['Input Example #2', 'Output Example #2']]) {
        const blocks = discoverSampleBlocks(dom(`<h3>${input}</h3>${pre('in')}<h3>${output}</h3>${pre('out')}`));
        assert.deepEqual(snapshot(blocks), [['2', 'input', 'in', false], ['2', 'output', 'out', false]], input);
    }
});

test('unnumbered example groups and repeated standalone role headings allocate distinct pairs', () => {
    for (const heading of ['样例', '示例', 'Sample', 'Example']) {
        const html = `<h2>${heading}</h2><p>Input:</p>${pre('i1')}<p>Output:</p>${pre('o1')}`
            + `<h2>${heading}</h2><p>输入：</p>${pre('i2', '')}<p>输出：</p>${pre('o2', 'none')}`;
        assert.deepEqual(snapshot(discoverSampleBlocks(dom(html))), [['1', 'input', 'i1', false], ['1', 'output', 'o1', false],
            ['2', 'input', 'i2', false], ['2', 'output', 'o2', false]], heading);
    }
    const html = `<h3>Sample Input</h3>${pre('i1')}<h3>Sample Output</h3>${pre('o1')}`
        + `<h3>Sample Input</h3>${pre('i2')}<h3>Sample Output</h3>${pre('o2')}`;
    assert.deepEqual(discoverSampleBlocks(dom(html)).map((block) => block.id), ['1', '1', '2', '2']);
});

test('no sample context, prose interruption and non-sample sections do not infer code as samples', () => {
    const ordinary = '<h2>输入格式</h2><p>输入：</p>' + pre('format') + '<p>输出：</p>' + pre('format-out')
        + '<h2>题解</h2><h3>输入</h3>' + pre('solution');
    assert.deepEqual(discoverSampleBlocks(dom(ordinary)), []);
    for (const heading of ['样例说明', '提示', '解释', '题解', '输入格式', 'Other Section', 'Sample Explanation', 'Notes']) {
        const html = `<h2>样例 1</h2><p>输入：</p>${pre('real')}<h2>${heading}</h2><p>输出：</p>${pre('not-sample')}`;
        assert.deepEqual(snapshot(discoverSampleBlocks(dom(html))), [['1', 'input', 'real', false]], heading);
    }
    const html = '<h2>样例 1</h2><p>输入：</p><p>This is explanation rather than sample data.</p>' + pre('not-sample');
    assert.deepEqual(discoverSampleBlocks(dom(html)), []);
    assert.deepEqual(discoverSampleBlocks(dom('<h2>样例 1</h2><p>输入：</p>' + pre('source', 'cpp'))), []);
    for (const [open, close] of [['<blockquote>', '</blockquote>'], ['<ul><li>', '</li></ul>'],
        ['<table><tbody><tr><td>', '</td></tr></tbody></table>']]) {
        assert.deepEqual(discoverSampleBlocks(dom(`${open}<h2>样例 1</h2><p>输入：</p>${pre('quoted')}${close}`)), [], open);
    }
    const nestedSolution = '<h2>题解</h2><h3>样例 1</h3><p>输入：</p>' + pre('solution-example')
        + '<h2>样例 2</h2><p>输入：</p>' + pre('real');
    assert.deepEqual(snapshot(discoverSampleBlocks(dom(nestedSolution))), [['2', 'input', 'real', false]]);
    const proseBreak = '<h2>样例 1</h2><p>输入：</p>' + pre('real')
        + '<p>下面解释上述示例。</p><p>输出：</p>' + pre('explained');
    assert.deepEqual(snapshot(discoverSampleBlocks(dom(proseBreak))), [['1', 'input', 'real', false]]);
});

test('sample pairing is scoped, respects numbered groups and does not attach a later duplicate output', () => {
    const html = '<div class="richmedia"><h2>样例 1</h2><p>输入：</p>' + pre('only-in')
        + '<h2>样例 2</h2><p>输出：</p>' + pre('only-out') + '</div>'
        + '<div class="richmedia"><h2>样例 1</h2><p>输入：</p>' + pre('second-in') + '<p>输出：</p>' + pre('second-out') + '</div>';
    const blocks = discoverSampleBlocks(dom(html));
    assert.deepEqual(snapshot(blocks), [['1', 'input', 'only-in', false], ['2', 'output', 'only-out', false],
        ['1', 'input', 'second-in', false], ['1', 'output', 'second-out', false]]);
    assert.notEqual(blocks[0].scope, blocks[2].scope);
    const duplicate = '<h2>样例 1</h2><p>输入：</p>' + pre('first')
        + '<h2>样例 1</h2><p>输入：</p>' + pre('duplicate') + '<p>输出：</p>' + pre('wrong-output');
    assert.deepEqual(snapshot(discoverSampleBlocks(dom(duplicate))), [['1', 'input', 'first', false]]);
    const laterOutput = '<h2>样例 1</h2><p>输入：</p>' + pre('first')
        + '<h2>样例 1</h2><p>输出：</p>' + pre('wrong-output');
    assert.deepEqual(snapshot(discoverSampleBlocks(dom(laterOutput))), [['1', 'input', 'first', false]]);
    assert.deepEqual(snapshot(discoverSampleBlocks(dom(pre('first', 'input1') + pre('duplicate', 'input1') + pre('wrong-output', 'output1')))),
        [['1', 'input', 'first', true]], 'Duplicate native inputs cannot borrow the last group output');
});

test('Prism code-toolbar wrappers and button text do not break fallback labels or create samples', () => {
    const wrap = (block) => `<div class="code-toolbar">${block}<div class="toolbar"><div class="toolbar-item"><a>Copy</a></div></div></div>`;
    const before = '<h2>Sample #3</h2><p>Input:</p>' + pre('in') + '<p>Output:</p>' + pre('out');
    const after = '<h2>Sample #3</h2><p>Input:</p>' + wrap(pre('in')) + '<p>Output:</p>' + wrap(pre('out'));
    assert.deepEqual(snapshot(discoverSampleBlocks(dom(before))), snapshot(discoverSampleBlocks(dom(after))));
});

test('inline SVG className objects do not interrupt sample discovery', () => {
    const root = dom('<svg><path></path></svg><h2>样例 1</h2><p>输入：</p>' + pre('in'));
    Object.defineProperty(root.children[0], 'className', { value: { baseVal: '', animVal: '' }, configurable: true });
    assert.deepEqual(snapshot(discoverSampleBlocks(root)), [['1', 'input', 'in', false]]);
    for (const tag of ['svg', 'math']) {
        const html = `<${tag}><div><h2>样例 99</h2><p>输入：</p>${pre('non-text')}</div></${tag}>`
            + '<h2>样例 1</h2><p>输入：</p>' + pre('real');
        assert.deepEqual(snapshot(discoverSampleBlocks(dom(html))), [['1', 'input', 'real', false]], tag);
    }
});

test('fallback metadata identifies only the explicit role label element and leaves native headers untouched', () => {
    for (const tag of ['p', 'strong', 'b', 'label', 'span', 'div', 'h3']) {
        const root = dom(`<div class="richmedia"><h2>样例 1</h2><${tag} id="input-label">输入：</${tag}>`
            + pre('in') + `<${tag} id="output-label">输出：</${tag}>` + pre('out') + '</div>');
        const before = getOuterHTML(root);
        const blocks = discoverSampleBlocks(root);
        assert.equal(blocks.length, 2, tag);
        assert.equal(blocks[0].label.attribs.id, 'input-label', tag);
        assert.equal(blocks[1].label.attribs.id, 'output-label', tag);
        assert.equal(getOuterHTML(root), before, 'Metadata discovery never moves labels');
    }
    const nested = discoverSampleBlocks(dom('<h2>样例 1</h2><p id="whole-label"><strong>输入：</strong></p>' + pre('in')));
    assert.equal(nested[0].label.attribs.id, 'whole-label', 'Keep the original enclosing label and its markup intact');
    const rawText = discoverSampleBlocks(dom('<h2>样例 1</h2>输入：' + pre('in')));
    assert.equal(rawText[0].label, undefined, 'Bare text nodes are recognized but not offered for relocation');
    const native = discoverSampleBlocks(dom('<div class="code-toolbar"><h2>输入数据 1</h2>' + pre('in', 'input1') + '</div>'));
    assert.equal(native[0].label, undefined, 'Native Hydro headings already have their own layout');
});

test('moving exact fallback label nodes into their Prism blocks preserves discovery and scoped sample pairing', () => {
    for (const roles of [
        ['<h2>样例 1</h2>', '<p><strong>输入：</strong></p>', '<p>输出：</p>'],
        ['', '<h3>输入样例 1</h3>', '<h3>输出样例 1</h3>'],
        ['', '<h3>Sample Input 1</h3>', '<h3>Sample Output 1</h3>'],
    ]) {
        const wrap = (code) => `<div class="code-toolbar">${code}<div class="toolbar"><a>复制</a></div></div>`;
        const group = (suffix) => `<div class="richmedia">${roles[0]}${roles[1]}${wrap(pre(`in-${suffix}`, 'text', ' 1\t2\n'))}`
            + `${roles[2]}${wrap(pre(`out-${suffix}`, 'none', '3\n'))}</div>`;
        const root = dom(group('one') + group('two'));
        const before = discoverSampleBlocks(root);
        const originalLabels = before.map((block) => block.label);
        before.forEach((block) => prependChild(block.code.parent.parent, block.label));
        const movedHtml = getOuterHTML(root);
        for (let pass = 0; pass < 3; pass += 1) {
            const after = discoverSampleBlocks(root);
            assert.deepEqual(snapshot(after), snapshot(before));
            after.forEach((block, index) => {
                assert.equal(block.scope, before[index].scope, 'Moving the label cannot move the code out of its scope');
                assert.equal(block.label, originalLabels[index], 'Rediscovery returns the same original label node');
                assert.equal(block.code.textContent, before[index].code.textContent);
            });
            assert.equal(getOuterHTML(root), movedHtml, 'Rediscovery of relocated labels remains read-only');
        }
    }
});
