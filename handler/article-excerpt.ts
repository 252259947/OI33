import { compile } from 'html-to-text';

function findTex(node: any): string | undefined {
    if (node.name === 'annotation' && node.attribs?.encoding === 'application/x-tex') {
        return (node.children || []).map((child: any) => child.data || '').join('');
    }
    for (const child of node.children || []) {
        const source = findTex(child);
        if (source !== undefined) return source;
    }
    return undefined;
}

const toText = compile({
    wordwrap: false,
    selectors: [
        // KaTeX carries HTML, MathML and TeX versions of each formula. Keep
        // only its source here; flattening visual spans can reverse fractions.
        { selector: 'span.katex', format: 'tex' },
        { selector: 'a', options: { ignoreHref: true } },
        { selector: 'img', format: 'skip' },
        ...[1, 2, 3, 4, 5, 6].map((level) => ({ selector: `h${level}`, options: { uppercase: false } })),
    ],
    formatters: {
        tex: (node, _walk, builder) => builder.addInline(findTex(node) ?? '[公式]'),
    },
});

// Return ordinary text, never a SafeString: templates must escape the result.
export function articleExcerpt(html: string): string {
    return toText(String(html || '')).replace(/\s+/gu, ' ').trim();
}
