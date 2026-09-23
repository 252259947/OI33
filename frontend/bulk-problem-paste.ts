export const MAX_BULK_PROBLEMS = 200;
export const BULK_PROBLEM_HELP = '支持批量粘贴题号，用逗号、中文逗号、空格或换行分隔（每次最多 200 个）；仅匹配本题库，全部匹配后按顺序加入。';

export interface BulkProblem { docId: number; pid?: string; title?: string }
export type ProblemLookup = (token: string) => Promise<BulkProblem[]>;

export function parseProblemTokens(text: string): string[] {
    if (text.length > 32000) throw new Error('粘贴内容过长，请分批添加（每次最多 200 个题号）。');
    const tokens = text.trim().split(/[\s,，;；]+/u).filter(Boolean);
    if (!tokens.length) throw new Error('请先粘贴题号。');
    if (tokens.length > MAX_BULK_PROBLEMS) throw new Error('每次最多添加 200 个题号，请分批粘贴。');
    if (tokens.some((token) => token.length > 128)) throw new Error('题号过长，请仅粘贴题号，不要包含题目正文。');
    return [...new Set(tokens)];
}

export function exactProblem(token: string, results: BulkProblem[]): BulkProblem | undefined {
    const valid = results.filter((p) => Number.isSafeInteger(p.docId) && p.docId > 0);
    if (/^\d+$/.test(token)) return valid.find((p) => p.docId === Number(token));
    const byPid = valid.find((p) => p.pid === token);
    if (byPid) return byPid;
    // Do not infer a P123 -> 123 alias from filtered search results: an inaccessible
    // actual PID P123 could exist. Bare numeric IDs remain unambiguous.
    return undefined;
}

export function mergeProblemIds(existing: number[], added: number[]): number[] {
    if ([...existing, ...added].some((id) => !Number.isSafeInteger(id) || id <= 0)) {
        throw new Error('已有题目尚未完成选择，请先选定或清除输入，再重新粘贴。');
    }
    return [...new Set([...existing, ...added])];
}

export async function resolveProblemTokens(
    tokens: string[], lookup: ProblemLookup,
    pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<BulkProblem[]> {
    if (!tokens.length || tokens.length > MAX_BULK_PROBLEMS) throw new Error('每次请添加 1–200 个题号。');
    const results: BulkProblem[] = [];
    const missing: string[] = [];
    // Bound both concurrency and request rate. No selected state is changed here.
    for (let offset = 0; offset < tokens.length; offset += 4) {
        if (offset) await pause(400);
        const batch = tokens.slice(offset, offset + 4);
        let matches: (BulkProblem | undefined)[];
        try {
            matches = await Promise.all(batch.map(async (token) => exactProblem(token, await lookup(token))));
        } catch {
            throw new Error('题目查询失败（网络异常或请求受限），本次未添加任何题目，请稍后重试。');
        }
        matches.forEach((problem, index) => {
            if (problem) results.push(problem);
            else missing.push(batch[index]);
        });
    }
    if (missing.length) throw new Error(`以下题号不存在或无权访问：${missing.join('、')}。本次未添加任何题目。`);
    return results;
}

export interface TrainingChapter { _id: number; title: string; pids: (number | string)[]; [key: string]: unknown }

export function parseTrainingChapters(source: string): TrainingChapter[] {
    let chapters: TrainingChapter[];
    try { chapters = JSON.parse(source); } catch { throw new Error('当前训练计划 JSON 格式有误，请先修正，再批量加题。'); }
    if (!Array.isArray(chapters) || !chapters.length
        || chapters.some((chapter) => !chapter || !Number.isSafeInteger(chapter._id)
            || typeof chapter.title !== 'string' || !Array.isArray(chapter.pids)
            || chapter.pids.some((pid) => !['number', 'string'].includes(typeof pid)))
        || new Set(chapters.map((chapter) => chapter._id)).size !== chapters.length) {
        throw new Error('请先在训练计划中建立合法章节（唯一的 _id、标题和 pids 数组），再批量加题。');
    }
    return chapters;
}

export function updateTrainingChapter(source: string, current: string, chapterId: number, pids: number[]): string {
    if (source !== current) throw new Error('查询期间训练计划已被修改，本次未添加题目。请重新选择章节后重试。');
    const chapters = parseTrainingChapters(source);
    const chapter = chapters.find((item) => item._id === chapterId);
    if (!chapter) throw new Error('目标章节已不存在，请重新选择。');
    chapter.pids = mergeProblemIds([], pids);
    return JSON.stringify(chapters, null, 2);
}
