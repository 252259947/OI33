// Deliberately an allowlist of the exact promotional paragraph observed in the
// imported statements. A book/source mention alone is not an advertisement.
const KNOWN_BOOK_AD = '**本题来自洛谷编写教材《深入浅出程序设计竞赛 - 基础篇》**，并带有详细的教程和讲解，点击下列链接了解本书详情。[【官方网店绝赞热卖中！】>>>](https://item.taobao.com/item.htm?id=637730514783)';
const compact = (value: string) => value.replace(/\s+/g, '');
const AD_SIGNATURE = compact(KNOWN_BOOK_AD);

interface CleanupResult {
    content: string;
    changed: boolean;
    removedParagraphs: number;
    removedBackgrounds: number;
    languages: string[];
}

interface Line {
    raw: string;
    text: string;
    protected: boolean;
}

function markdownLines(content: string): Line[] {
    const raw = content.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) || [];
    if (raw[raw.length - 1] === '') raw.pop();
    let fence = '';
    let comment = false;
    let htmlTag = '';
    return raw.map((value) => {
        const text = value.replace(/[\r\n]+$/, '');
        let protectedLine = !!fence || comment || !!htmlTag || /^(?: {4}|\t)/.test(text);
        if (fence) {
            if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(text)) fence = '';
        } else {
            const opening = text.match(/^ {0,3}(`{3,}|~{3,})/);
            if (opening) { fence = opening[1]; protectedLine = true; }
        }
        if (text.includes('<!--')) { comment = true; protectedLine = true; }
        if (comment && text.includes('-->')) comment = false;
        // Treat raw HTML blocks conservatively. No cleanup inside embedded HTML.
        if (!htmlTag) {
            const tag = text.match(/^ {0,3}<(pre|script|style|textarea|div|section|table|details)\b/i);
            if (tag) { htmlTag = tag[1]; protectedLine = true; }
        }
        if (htmlTag && new RegExp(`</${htmlTag}\\s*>`, 'i').test(text)) htmlTag = '';
        return { raw: value, text, protected: protectedLine };
    });
}

function cleanupMarkdown(content: string) {
    const lines = markdownLines(content);
    const headings: { start: number; end: number; level: number; title: string }[] = [];
    const title = (text: string) => text.trim().replace(/^\*\*(.*?)\*\*$/, '$1').trim();
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].protected) continue;
        const atx = lines[i].text.match(/^ {0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/);
        if (atx) headings.push({ start: i, end: i + 1, level: atx[1].length, title: title(atx[2]) });
        else if (lines[i].text.trim() && lines[i + 1] && !lines[i + 1].protected
            && /^ {0,3}(?:={3,}|-{3,})\s*$/.test(lines[i + 1].text)) {
            headings.push({ start: i, end: i + 2, level: lines[i + 1].text.trim()[0] === '=' ? 1 : 2,
                title: title(lines[i].text) });
            i++;
        }
    }
    const headingStarts = new Set(headings.map((heading) => heading.start));
    const removed = new Set<number>();
    let removedParagraphs = 0;
    let removedBackgrounds = 0;
    for (let h = 0; h < headings.length; h++) {
        const heading = headings[h];
        if (!['题目背景', '背景'].includes(heading.title)) continue;
        const end = headings.slice(h + 1).find((next) => next.level <= heading.level)?.start ?? lines.length;
        const ownRemovals = new Set<number>();
        for (let i = heading.end; i < end;) {
            if (!lines[i].text.trim() || headingStarts.has(i)) { i++; continue; }
            const start = i++;
            while (i < end && lines[i].text.trim() && !headingStarts.has(i)) i++;
            const paragraph = lines.slice(start, i);
            if (paragraph.some((line) => line.protected) || compact(paragraph.map((line) => line.text).join('\n')) !== AD_SIGNATURE) continue;
            removedParagraphs++;
            while (i < end && !lines[i].text.trim()) i++;
            for (let j = start; j < i; j++) ownRemovals.add(j);
        }
        if (!ownRemovals.size) continue;
        const hasBackground = lines.slice(heading.end, end).some((line, index) => (
            !ownRemovals.has(heading.end + index) && line.text.trim()
        ));
        if (!hasBackground) {
            removedBackgrounds++;
            for (let i = heading.start; i < end; i++) removed.add(i);
        } else for (const i of ownRemovals) removed.add(i);
    }
    return { content: lines.filter((_, index) => !removed.has(index)).map((line) => line.raw).join(''),
        removedParagraphs, removedBackgrounds };
}

/** Pure, conservative content-only transformation for an explicitly backed-up maintenance run. */
export function cleanupProblemAds(content: string, options: { html?: boolean } = {}): CleanupResult {
    const unchanged = { content, changed: false, removedParagraphs: 0, removedBackgrounds: 0, languages: [] };
    if (options.html || typeof content !== 'string') return unchanged;
    let parsed: any;
    let isJson = false;
    try { parsed = JSON.parse(content); isJson = true; } catch { /* Normal Markdown. */ }
    if (!isJson) {
        const cleaned = cleanupMarkdown(content);
        return { ...cleaned, changed: cleaned.content !== content, languages: cleaned.removedParagraphs ? ['markdown'] : [] };
    }
    // Hydro uses a JSON language-to-Markdown map. Do not reinterpret arrays,
    // nested structures or scalar JSON as a Markdown statement.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.values(parsed).some((value) => typeof value !== 'string')) return unchanged;
    const result: Record<string, string> = Object.create(null);
    let removedParagraphs = 0;
    let removedBackgrounds = 0;
    const languages: string[] = [];
    for (const [language, value] of Object.entries(parsed)) {
        const cleaned = cleanupMarkdown(value as string);
        result[language] = cleaned.content;
        removedParagraphs += cleaned.removedParagraphs;
        removedBackgrounds += cleaned.removedBackgrounds;
        if (cleaned.removedParagraphs) languages.push(language);
    }
    return removedParagraphs ? { content: JSON.stringify(result), changed: true, removedParagraphs, removedBackgrounds, languages } : unchanged;
}
