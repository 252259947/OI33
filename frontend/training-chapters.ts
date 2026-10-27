import { parseTrainingChapters, TrainingChapter } from './bulk-problem-paste';
import { validateTrainingDependencies } from './training-progress';

export type ChapterAction = { type: 'add' } | { type: 'rename'; id: number; title: string }
    | { type: 'move'; id: number; direction: -1 | 1 } | { type: 'remove'; id: number };

export function changeTrainingChapter(source: string, action: ChapterAction): { source: string; selectedId: number } {
    const chapters = parseTrainingChapters(source);
    let selectedId: number;
    if (action.type === 'add') {
        selectedId = Math.max(0, ...chapters.map((chapter) => chapter._id)) + 1;
        if (!Number.isSafeInteger(selectedId)) throw new Error('章节编号超出范围，请在高级模式中整理编号。');
        chapters.push({ _id: selectedId, title: `新章节 ${chapters.length + 1}`, pids: [], requireNids: [] });
    } else {
        const index = chapters.findIndex((chapter) => chapter._id === action.id);
        if (index < 0) throw new Error('章节已变化，请刷新章节后重试。');
        selectedId = action.id;
        if (action.type === 'rename') {
            if (!action.title.trim() || action.title.length > 200) throw new Error('章节名称不能为空，且最多 200 字。');
            chapters[index].title = action.title.trim();
        } else if (action.type === 'move') {
            const to = index + action.direction;
            if (to >= 0 && to < chapters.length) [chapters[index], chapters[to]] = [chapters[to], chapters[index]];
        } else {
            if (chapters.length === 1) throw new Error('训练至少保留一个章节。可先新增章节，再删除旧章节。');
            const dependents = chapters.filter((chapter) => Array.isArray(chapter.requireNids) && chapter.requireNids.includes(action.id));
            if (dependents.length) throw new Error(`“${dependents.map((chapter) => chapter.title).join('、')}”以此章节为先修条件，请先在高级模式调整先修关系，再删除。`);
            chapters.splice(index, 1);
            selectedId = chapters[Math.min(index, chapters.length - 1)]._id;
        }
    }
    return { source: JSON.stringify(chapters, null, 2), selectedId };
}

export function validateTrainingPlan(source: string): TrainingChapter[] {
    const chapters = parseTrainingChapters(source);
    const ids = new Set(chapters.map((chapter) => chapter._id));
    for (const chapter of chapters) {
        if (!chapter.title.trim()) throw new Error('请为每个章节填写名称。');
        if (!chapter.pids.length) throw new Error(`“${chapter.title}”还没有题目，请先加入题目再保存训练。`);
        if (!Array.isArray(chapter.requireNids) || chapter.requireNids.some((id) => !ids.has(id))) throw new Error(`“${chapter.title}”的先修章节无效，请在高级模式中修正。`);
    }
    validateTrainingDependencies(chapters);
    return chapters;
}
