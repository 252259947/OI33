import { AsyncLocalStorage } from 'node:async_hooks';
import { Context, ContestModel, ForbiddenError, moment, ObjectId, PERM, ValidationError } from 'hydrooj';

const fields = ['title', 'content', 'rule', 'pids', 'rated', 'assign', '_code', 'maintainer',
    'allowViewCode', 'allowPrint', 'keepScoreboardHidden', 'langs', 'autoHide', 'beginAt', 'endAt', 'duration', 'lockAt'];
const copyContext = new AsyncLocalStorage<any>();

export function guardContestEditor(h: any) {
    const domainId = h.domain?._id;
    if (!domainId || (h.args.domainId && h.args.domainId !== domainId)) throw new ForbiddenError('请求域与当前域不一致。');
    if (!h.context?.params?.tid && h.args.tid) throw new ForbiddenError('新建比赛不能携带已有比赛编号。');
}

export function parseContestTime(date: unknown, time: unknown, zone: string) {
    if (typeof date !== 'string' || typeof time !== 'string' || !/^\d{4}-\d{1,2}-\d{1,2}$/.test(date)
        || !/^\d{1,2}:\d{2}$/.test(time) || !moment.tz.zone(zone)) throw new ValidationError('比赛时间');
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    const canonical = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const value = moment.tz(canonical, 'YYYY-MM-DD HH:mm', true, zone);
    // Reject impossible dates and local times skipped by daylight saving time.
    if (!value.isValid() || value.format('YYYY-MM-DD HH:mm') !== canonical) throw new ValidationError('比赛时间');
    return value;
}

export function syncContestEndTime(h: any) {
    if (h.args.operation !== 'update') return;
    const { oi33EndAtDate: date, oi33EndAtTime: time } = h.args;
    // Preserve the existing duration-based API for older clients.
    if (date === undefined && time === undefined) return;
    const begin = parseContestTime(h.args.beginAtDate, h.args.beginAtTime, h.user.timeZone);
    const end = parseContestTime(date, time, h.user.timeZone);
    if (!end.isAfter(begin)) throw new ValidationError('结束时间必须晚于开始时间');
    h.args.duration = end.diff(begin) / 3600000;
}

async function copySource(h: any) {
    const value = h.args.copyFrom;
    if (value === undefined) return null;
    if (h.context?.params?.tid || typeof value !== 'string' || !/^[0-9a-f]{24}$/i.test(value)) throw new ValidationError('copyFrom');
    h.checkPerm(PERM.PERM_CREATE_CONTEST);
    const source = await ContestModel.get(h.domain._id, new ObjectId(value));
    if (source.domainId !== h.domain._id || !ContestModel.RULES[source.rule] || ContestModel.RULES[source.rule].hidden) {
        throw new ForbiddenError('只能复制当前域内的比赛。');
    }
    h.checkPerm(h.user.own(source) ? PERM.PERM_EDIT_CONTEST_SELF : PERM.PERM_EDIT_CONTEST);
    return source;
}

export function contestCopyDraft(source: any) {
    // Explicit configuration allowlist: never leak/copy owner, identities,
    // participants, results, unlocked state, or attachment storage paths.
    return Object.fromEntries(fields.filter(key => source[key] !== undefined)
        .map(key => [key, Array.isArray(source[key]) ? [...source[key]] : source[key]]));
}

export async function prepareContestForm(h: any) {
    const source = await copySource(h);
    const body = h.response.body;
    if (source) {
        body.tdoc = contestCopyDraft(source);
        body.beginAt = moment(source.beginAt).tz(h.user.timeZone);
        body.duration = (new Date(source.endAt).getTime() - new Date(source.beginAt).getTime()) / 3600000;
        body.pids = source.pids.join(',');
        body.page_name = 'contest_create';
        body.files = [];
        body.oi33CopyFrom = String(source.docId);
    }
    const end = body.tdoc?.endAt ? moment(body.tdoc.endAt).tz(h.user.timeZone)
        : body.beginAt.clone().add(body.duration, 'hours');
    body.oi33EndAtDate = end.format('YYYY-MM-DD');
    body.oi33EndAtTime = end.format('HH:mm');
    h.response.addHeader('Cache-Control', 'private, no-store');
}

export function copyProblemSettings(data: any) {
    const source = copyContext.getStore();
    if (!source) return;
    // Scores and balloon colors are problem configuration, not student results.
    const score: Record<number, number> = {};
    const balloon: Record<number, any> = {};
    for (const pid of data.pids) {
        if (!source.pids.includes(pid)) continue;
        if (Number.isSafeInteger(source.score?.[pid]) && source.score[pid] > 0) score[pid] = source.score[pid];
        const value = source.balloon?.[pid];
        if (typeof value === 'string') balloon[pid] = value;
        else if (value && typeof value.color === 'string' && typeof value.name === 'string') {
            balloon[pid] = { color: value.color, name: value.name };
        }
    }
    if (Object.keys(score).length) data.score = score;
    if (Object.keys(balloon).length) data.balloon = balloon;
}

export async function prepareContestUpdate(h: any) {
    if (h.args.operation !== 'update') return;
    syncContestEndTime(h);
    const source = await copySource(h);
    if (!source) return;
    const original = h.postUpdate;
    h.postUpdate = function (...args: any[]) {
        return copyContext.run(source, () => original.apply(this, args));
    };
}

export function apply(ctx: Context) {
    ctx.on('handler/before-prepare/ContestEdit', guardContestEditor);
    ctx.on('handler/after/ContestEdit#get', prepareContestForm);
    ctx.on('handler/before/ContestEdit#post', prepareContestUpdate);
    ctx.on('contest/before-add', copyProblemSettings);
}
