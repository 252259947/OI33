import {
    Context, ContestAlreadyAttendedError, ContestModel, ForbiddenError, Handler, ObjectId, param, PERM, PRIV, ProblemModel, Types,
} from 'hydrooj';
import { isEducationCoach } from '../model/education-auth';
import { educationRosterColl, listClassGroups } from '../model/education';
import { enforceEnrollment } from './enrollment';

const order = { penaltySince: -1, endAt: -1, beginAt: -1, _id: -1 } as const;

export async function homeworkGroups(user: any, domainId: string): Promise<string[]> {
    const groups = await listClassGroups(domainId);
    return groups.filter((group) => isEducationCoach(user) || (user._id > 0 && group.uids.includes(user._id)))
        .map((group) => group.name);
}

export function homeworkQuery(user: any, groups: string[], group = '', q = '') {
    if (group && !groups.includes(group)) throw new ForbiddenError('只能筛选自己所属的班型。');
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {
        rule: 'homework',
        ...(!isEducationCoach(user) || group ? { assign: { $in: group ? [group] : groups } } : {}),
        ...(q ? { title: { $regex: new RegExp(escaped, 'i') } } : {}),
    };
}

async function addRosterCounts(domainId: string, tdocs: any[]) {
    const rosters = await educationRosterColl.find({ domainId, tid: { $in: tdocs.map((doc) => doc.docId) } }).toArray();
    for (const doc of tdocs) {
        const roster = rosters.find((item) => String(item.tid) === String(doc.docId));
        if (roster) doc.educationRosterCount = roster.entries.filter((entry) => !entry.exemptAt).length;
    }
}

class HomeworkMainAdapter extends Handler {
    @param('group', Types.Name, true)
    @param('page', Types.PositiveInt, true)
    @param('q', Types.String, true)
    async get(domainId: string, group = '', page = 1, q = '') {
        this.checkPerm(PERM.PERM_VIEW_HOMEWORK);
        const groups = await homeworkGroups(this.user, domainId);
        const [tdocs, tpcount] = await this.paginate(
            ContestModel.getMulti(domainId, homeworkQuery(this.user, groups, group, q)).sort(order), page, 'contest',
        );
        await addRosterCounts(domainId, tdocs);
        this.response.addHeader('Cache-Control', 'private, no-store');
        this.response.template = 'homework_main.html';
        this.response.body = {
            tdocs, tpcount, page, groups, group, q, educationIsCoach: isEducationCoach(this.user),
            calendar: tdocs.map((doc) => ({ ...doc, url: this.url('homework_detail', { tid: doc.docId }) })),
        };
    }
}

export async function ensureHomeworkAttendance(h: any, tdoc: any) {
    if (ContestModel.isDone(tdoc)) return;
    h.checkPerm(PERM.PERM_ATTEND_HOMEWORK);
    const domainId = h.domain._id;
    let status = await ContestModel.getStatus(domainId, tdoc.docId, h.user._id);
    if (!status?.attend) {
        try {
            await ContestModel.attend(domainId, tdoc.docId, h.user._id,
                ContestModel.isOngoing(tdoc) ? { startAt: new Date() } : {});
        } catch (error) {
            // Only a confirmed concurrent attendance is harmless; never hide a DB failure.
            if (!(error instanceof ContestAlreadyAttendedError)
                || !(await ContestModel.getStatus(domainId, tdoc.docId, h.user._id))?.attend) throw error;
        }
        status = await ContestModel.getStatus(domainId, tdoc.docId, h.user._id);
    }
    if (status?.attend && !status.startAt && ContestModel.isOngoing(tdoc)) {
        await ContestModel.setStatus(domainId, tdoc.docId, h.user._id, { startAt: new Date() });
    }
}

function allowCoachRead(h: any, tdoc: any) {
    if (h.oi33HomeworkReadProxy) return;
    const original = h.user;
    // These two core read gates name the same homework differently. Grant only
    // on this verified homework request, never on the cached User or its role.
    h.user = Object.create(original);
    // Hydro's multiple arguments mean OR; combined bigint masks still pass
    // through to its native checker, so no edit/scoreboard bit is added.
    h.user.hasPerm = (...permissions: bigint[]) => permissions.some((permission) => (
        permission === PERM.PERM_VIEW_HIDDEN_HOMEWORK || permission === PERM.PERM_VIEW_HIDDEN_CONTEST
    )) || original.hasPerm(...permissions);
    h.oi33HomeworkReadProxy = true;
    if (h.request.method.toLowerCase() !== 'get'
        || !/^Problem(Detail|Submit|FileDownload)Handler$/.test(h.constructor.name)
        || typeof h.__prepare !== 'function') return;
    const prepare = h.__prepare;
    h.__prepare = async function (...args: any[]) {
        const result = await prepare.apply(this, args);
        // Preview only: no attendance/scoreboard row is written by a teacher GET.
        if (String(this.tdoc?.docId) === String(tdoc.docId) && (!this.tsdoc?.attend || !this.tsdoc.startAt)) {
            this.tsdoc = { ...(this.tsdoc || {}), attend: 1, startAt: this.tsdoc?.startAt || tdoc.beginAt };
        }
        return result;
    };
}

export async function enforceHomeworkAccess(h: any) {
    const name = h.constructor.name.replace(/Handler$/, '');
    // Only handlers whose route actually consumes a homework/contest ID. A
    // stray ?tid=homework on a contest list must never grant hidden-contest reads.
    const relevant = new Set([
        'HomeworkDetail', 'HomeworkEdit', 'HomeworkFiles',
        'ContestCode', 'ContestScoreboard', 'ContestFileDownload',
        'ProblemDetail', 'ProblemSubmit', 'ProblemFileDownload',
    ]).has(name);
    if (!relevant || !/^[a-f\d]{24}$/i.test(String(h.args?.tid || ''))) return;
    const tid = String(h.args.tid).toLowerCase();
    for (const source of [h.request.params, h.request.query, h.request.body]) {
        if (source?.tid !== undefined && String(source.tid).toLowerCase() !== tid) {
            throw new ForbiddenError('请求中的作业编号不一致。');
        }
    }
    const domainId = h.domain._id;
    if (h.args.domainId && h.args.domainId !== domainId) throw new ForbiddenError('不能通过参数切换作业所属域。');
    const tdoc = await ContestModel.get(domainId, new ObjectId(String(h.args.tid)));
    if (tdoc.rule !== 'homework') return;
    // Explicitly finish the identity check before any automatic status write,
    // including direct problem POSTs and independent invocation of this guard.
    await enforceEnrollment(h);
    h.checkPriv(PRIV.PRIV_USER_PROFILE);
    h.checkPerm(PERM.PERM_VIEW_HOMEWORK);
    h.response.addHeader('Cache-Control', 'private, no-store');
    const coach = isEducationCoach(h.user);
    const groups = await homeworkGroups(h.user, domainId);
    if (!coach && !tdoc.assign?.some((group: string) => groups.includes(group))) {
        throw new ForbiddenError('这份作业未开放给你所在的班型。');
    }
    if (coach) allowCoachRead(h, tdoc);
    const problemRoute = ['ProblemDetail', 'ProblemSubmit', 'ProblemFileDownload'].includes(name);
    if (problemRoute) {
        const pdoc = await ProblemModel.get(domainId, h.request.params?.pid ?? h.args.pid);
        if (!pdoc || !tdoc.pids.includes(pdoc.docId)) throw new ForbiddenError('题目不属于这份作业。');
        // Native ProblemDetail reads @query(tid), while its parent and submit
        // read @param(tid). Normalize a body-only ID after validating all sources.
        h.request.query ||= {};
        h.request.query.tid = tid;
        // Retain the native start/deadline rejection without writing attendance first.
        if (ContestModel.isNotStarted(tdoc) || ContestModel.isDone(tdoc)) return;
    }
    const method = h.request.method.toLowerCase();
    if ((!coach && (name === 'HomeworkDetail' || problemRoute))
        || (coach && name === 'ProblemSubmit' && method === 'post')) {
        if (name === 'ProblemSubmit' && method === 'post') h.checkPerm(PERM.PERM_SUBMIT_PROBLEM);
        await ensureHomeworkAttendance(h, tdoc);
    }
}

export function apply(ctx: Context) {
    ctx.on('handler/create', (h: any) => {
        if (h.constructor.name !== 'HomeHandler') return;
        h.getHomework = async function (domainId: string, limit = 5) {
            if (!this.user.hasPerm(PERM.PERM_VIEW_HOMEWORK)) return [[], {}];
            const groups = await homeworkGroups(this.user, domainId);
            const tdocs = await ContestModel.getMulti(domainId, homeworkQuery(this.user, groups)).sort(order).limit(limit).toArray();
            return [tdocs, await ContestModel.getListStatus(domainId, this.user._id, tdocs.map((doc) => doc.docId))];
        };
    });
    ctx.on('handler/before/HomeworkMain#get', (h: any) => { h.get = HomeworkMainAdapter.prototype.get; });
    const events = ctx as any;
    events.on('handler/before-prepare', enforceHomeworkAccess);
    events.on('handler/before-operation', enforceHomeworkAccess);
    ctx.on('handler/after/HomeworkDetail#get', async (h: any) => {
        const body = h.response.body;
        if (isEducationCoach(h.user) && body?.tdoc && !body.pdict) {
            body.pdict = await ProblemModel.getList(h.domain._id, body.tdoc.pids, true, true, ProblemModel.PROJECTION_CONTEST_LIST);
            body.psdict = {};
            body.rdict = {};
        }
    });
}
