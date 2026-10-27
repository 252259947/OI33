export interface ArticleDraftFields {
    title: string;
    content: string;
    problemId: string;
    visibility: string;
}

export function articleDraftKey(owner: string, article: string) {
    return `oi33:article-draft:v1:${encodeURIComponent(owner)}:${encodeURIComponent(article)}`;
}

export function parseArticleDraft(raw: string | null): { fields: ArticleDraftFields; base: string; savedAt: number } | null {
    try {
        const value = JSON.parse(raw || 'null');
        if (value?.version !== 1 || typeof value.base !== 'string' || !Number.isFinite(value.savedAt)) return null;
        if (Date.now() - value.savedAt > 30 * 24 * 3600 * 1000) return null;
        if (!['title', 'content', 'problemId', 'visibility'].every((key) => typeof value.fields?.[key] === 'string')) return null;
        if (!['public', 'private', 'unlisted'].includes(value.fields.visibility)) return null;
        return value;
    } catch { return null; }
}
