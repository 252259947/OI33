import { homeworkProgress } from './education-policy';

export const HOMEWORK_PROGRESS_FILTERS = ['all', 'unfinished', 'completed'] as const;
export type HomeworkProgressFilter = typeof HOMEWORK_PROGRESS_FILTERS[number];

// The site's default deadline is 2100-01-01 00:00 Asia/Shanghai.
const LONG_TERM_DEADLINE = Date.UTC(2099, 11, 31, 16);

export function isLongTermHomework(doc: any) {
    return new Date(doc.penaltySince || doc.endAt).getTime() >= LONG_TERM_DEADLINE;
}

export function homeworkDeadlineLabel(doc: any) {
    const date = new Date(doc.penaltySince || doc.endAt);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date) + '（北京时间）';
}

export function annotateHomeworkProgress(doc: any, status: any, now = new Date(), acceptedStatus = 1) {
    const pids = [...new Set<number>(doc.pids || [])];
    // Native homework detail is the latest effective submission per problem,
    // rebuilt by Hydro on judging/rejudging. Never use global problem AC or an
    // "ever accepted" journal scan, which can disagree with the scoreboard.
    const progress = homeworkProgress(pids, { detail: status?.detail }, new Date(doc.penaltySince || doc.endAt), now, acceptedStatus);
    return { ...doc, educationLongTerm: isLongTermHomework(doc),
        educationProgress: { completed: progress.completed, total: pids.length, complete: progress.complete,
            attempted: progress.attempted, percent: pids.length ? Math.round(progress.completed / pids.length * 100) : 0 } };
}

export function selectStudentHomework(docs: any[], filter: HomeworkProgressFilter = 'all', now = new Date()) {
    // Actionable, genuinely soon-due work comes before long-term or closed work.
    const deadlineBucket = (doc: any) => (
        new Date(doc.endAt).getTime() < now.getTime() ? 2 : doc.educationLongTerm ? 1 : 0
    );
    return docs.filter((doc) => filter === 'all'
        || (filter === 'completed' ? doc.educationProgress.complete : !doc.educationProgress.complete))
        .sort((a, b) => Number(a.educationProgress.complete) - Number(b.educationProgress.complete)
            || deadlineBucket(a) - deadlineBucket(b)
            || new Date(a.penaltySince || a.endAt).getTime() - new Date(b.penaltySince || b.endAt).getTime()
            || new Date(b.beginAt).getTime() - new Date(a.beginAt).getTime()
            || String(b.docId).localeCompare(String(a.docId)));
}
