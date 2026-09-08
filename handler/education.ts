import {
    Context, ContestModel, ForbiddenError, Handler, moment, ObjectId, param, PERM, PRIV,
    ProblemModel, STATUS, Types, UserModel, ValidationError,
} from 'hydrooj';
import { assertEducationCoach, isEducationAdmin, isEducationCoach } from '../model/education-auth';
import {
    confirmRosterChange, createHomeworkRoster, educationRosterColl, ensureEducationIndexes,
    getHomeworkRoster, getTeachingStudentScope, listClassGroups, normalizeClassNames, prepareRosterChange, resolveClassStudents, setClassStudents,
} from '../model/education';
import { homeworkProgress, uniqueStudentIds } from '../model/education-policy';
import { userColl } from '../model/user';
import { enrollmentColl } from '../model/enrollment';

function privatePage(h: any) {
    h.response.addHeader('Cache-Control', 'private, no-store');
}

export function homeworkDefaults(timeZone: string, now = new Date()) {
    const beginAt = moment(now).tz(timeZone).startOf('day');
    return {
        dateBeginText: beginAt.format('YYYY-M-D'), timeBeginText: '0:00',
        datePenaltyText: '2100-1-1', timePenaltyText: '0:00',
    };
}

// Core Types.Content rejects even an empty string. Only this request-local
// adapter relaxes those two fields; no global validator or core class changes.
const OptionalHomeworkContent = [
    (value: string) => value.trim(),
    (value: unknown) => typeof value === 'string' && value.trim().length < 65536,
] as const;

class HomeworkUpdateAdapter extends Handler {
    @param('tid', Types.ObjectId, true)
    @param('beginAtDate', Types.Date)
    @param('beginAtTime', Types.Time)
    @param('penaltySinceDate', Types.Date)
    @param('penaltySinceTime', Types.Time)
    @param('title', Types.Title)
    @param('content', OptionalHomeworkContent, true)
    @param('pids', OptionalHomeworkContent, true)
    @param('rated', Types.Boolean)
    @param('maintainer', Types.NumericArray, true)
    @param('assign', Types.CommaSeperatedArray, true)
    async postUpdate(
        domainId: string, tid: ObjectId, beginAtDate: string, beginAtTime: string,
        penaltySinceDate: string, penaltySinceTime: string, title: string,
        content = '', pids = '', rated = false, maintainer: number[] = [], assign: string[] = [],
    ) {
        // Hydro's decorated method explicitly supports validated positional
        // calls. Reuse its authorization, problem checks, writes and recalc.
        // Ignore client-supplied extension/penalty/language settings entirely.
        return (this as any).oi33HomeworkNativeUpdate.call(this,
            domainId, tid, beginAtDate, beginAtTime, penaltySinceDate, penaltySinceTime,
            0, {}, title, content, pids, rated, maintainer, assign, []);
    }
}

function parseUids(value: unknown): number[] {
    const parts = String(value || '').trim().split(/[\s,，]+/).filter(Boolean);
    if (parts.length > 5000 || parts.some((part) => !/^\d+$/.test(part) || +part < 1 || !Number.isSafeInteger(+part))) {
        throw new ValidationError('学生 UID');
    }
    return uniqueStudentIds(parts.map(Number));
}

async function assertHomeworkManager(h: any, tdoc: any) {
    assertEducationCoach(h.user);
    if (tdoc.rule !== 'homework') throw new ValidationError('作业');
    if (!isEducationAdmin(h.user) && !h.user.own(tdoc)) throw new ForbiddenError('仅作业创建者、协作者或管理员可以管理此作业。');
    h.checkPerm(h.user.own(tdoc) ? PERM.PERM_EDIT_HOMEWORK_SELF : PERM.PERM_EDIT_HOMEWORK);
}

export async function rosterNames(domainId: string, uids: number[]) {
    // Existing legacy groups/rosters may contain arbitrary global UIDs. Membership
    // must be proven before either legacy or new real names are queried/displayed.
    const { inDomain } = await getTeachingStudentScope(domainId, uids);
    const [users, identities, enrollments] = await Promise.all([
        UserModel.getList(domainId, inDomain), userColl.find({ _id: { $in: inDomain } } as any).toArray(),
        enrollmentColl.find({ domainId, _id: { $in: inDomain } }).project({ _id: 1, realName: 1 }).toArray(),
    ]);
    const names: Record<number, string> = {};
    for (const uid of uids) names[uid] = !inDomain.includes(uid) ? `UID ${uid}（非本域成员）`
        : enrollments.find((doc: any) => doc._id === uid)?.realName
        || identities.find((doc: any) => doc._id === uid)?.realname_name
        || users[uid]?.uname || `UID ${uid}`;
    return names;
}

class EducationClassesHandler extends Handler {
    async prepare() { privatePage(this); assertEducationCoach(this.user); }

    async get({ domainId }) {
        const groups = await listClassGroups(domainId);
        const names = await rosterNames(domainId, uniqueStudentIds(groups.flatMap((group) => group.uids)));
        this.response.template = 'oi33_education_classes.html';
        this.response.body = { groups, names };
    }

    @param('name', Types.String)
    @param('uids', Types.String, true)
    async postUpdate(domainId: string, name: string, uids = '') {
        await setClassStudents(domainId, name.trim(), parseUids(uids), this.user._id);
        this.response.redirect = this.url('oi33_education_classes');
    }
}

class EducationHomeworkHandler extends Handler {
    tdoc: any;

    @param('tid', Types.ObjectId)
    async prepare(domainId: string, tid: ObjectId) {
        privatePage(this);
        this.tdoc = await ContestModel.get(domainId, tid);
        await assertHomeworkManager(this, this.tdoc);
    }

    async renderProgress(domainId: string, preview?: any) {
        const tdoc = this.tdoc;
        const roster = await getHomeworkRoster(domainId, tdoc.docId);
        const entries = roster?.entries || [];
        const uids = uniqueStudentIds([...entries.map((entry) => entry.uid), ...(preview?.entries || []).map((entry) => entry.uid)]);
        const [names, statuses, pdict] = await Promise.all([
            rosterNames(domainId, uids),
            ContestModel.getMultiStatus(domainId, { docId: tdoc.docId, uid: { $in: uids } }).toArray(),
            ProblemModel.getList(domainId, tdoc.pids, true, true),
        ]);
        const now = new Date();
        const rows = entries.map((entry) => ({ ...entry, name: names[entry.uid],
            ...homeworkProgress(tdoc.pids, statuses.find((status) => status.uid === entry.uid),
                tdoc.penaltySince || tdoc.endAt, now, STATUS.STATUS_ACCEPTED) }));
        const active = rows.filter((row) => !row.exemptAt);
        const summary = { total: active.length, complete: active.filter((row) => row.complete).length,
            partial: active.filter((row) => !row.complete && row.attempted).length,
            notStarted: active.filter((row) => !row.attempted).length,
            overdue: active.filter((row) => row.overdue).length, exempt: rows.length - active.length };
        this.response.template = 'oi33_education_homework.html';
        this.response.body = { tdoc, roster, rows, summary, pdict, preview, names };
    }

    async get({ domainId }) { await this.renderProgress(domainId); }

    @param('mode', Types.String)
    @param('uids', Types.String, true)
    @param('reason', Types.String, true)
    async postPreview(domainId: string, mode: string, uids = '', reason = '') {
        const preview = await prepareRosterChange(domainId, this.tdoc.docId, this.user._id, mode, parseUids(uids), reason);
        await this.renderProgress(domainId, preview);
    }

    @param('token', Types.String)
    @param('confirmed', Types.String)
    async postConfirm(domainId: string, token: string, confirmed: string) {
        if (confirmed !== 'yes') throw new ValidationError('确认', '请先预览并确认名单变化。');
        await confirmRosterChange(domainId, this.tdoc.docId, this.user._id, token);
        this.response.redirect = this.url('oi33_education_homework', { tid: this.tdoc.docId });
    }
}

class EducationTasksHandler extends Handler {
    async prepare() { privatePage(this); }

    async redirectToHomework() {
        this.response.redirect = this.url('homework_main');
    }

    @param('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        const query = { domainId, entries: { $elemMatch: { uid: this.user._id, exemptAt: { $exists: false } } } };
        const pageSize = 30;
        const [rosters, total] = await Promise.all([
            educationRosterColl.find(query).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
            educationRosterColl.countDocuments(query),
        ]);
        const groups = (await UserModel.listGroup(domainId, this.user._id)).map((group) => group.name);
        const tasks = [];
        for (const roster of rosters) {
            let tdoc: any;
            try { tdoc = await ContestModel.get(domainId, roster.tid); } catch { continue; }
            // A historical roster is not an access grant. Class membership stays dynamic.
            if (tdoc.assign?.length && !tdoc.assign.some((group) => groups.includes(group))
                && !this.user.own(tdoc) && !this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK)) continue;
            const status = await ContestModel.getStatus(domainId, tdoc.docId, this.user._id);
            tasks.push({ tdoc, ...homeworkProgress(tdoc.pids, status, tdoc.penaltySince || tdoc.endAt,
                new Date(), STATUS.STATUS_ACCEPTED) });
        }
        tasks.sort((a, b) => Number(a.complete) - Number(b.complete) || +a.tdoc.penaltySince - +b.tdoc.penaltySince);
        this.response.template = 'oi33_education_tasks.html';
        this.response.body = { tasks, page, tpcount: Math.ceil(total / pageSize) };
    }
}

export async function apply(ctx: Context) {
    await ensureEducationIndexes();
    ctx.Route('oi33_education_classes', '/oi33/education/classes', EducationClassesHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_education_homework', '/oi33/education/homework/:tid', EducationHomeworkHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_education_tasks', '/oi33/education/tasks', EducationTasksHandler, PERM.PERM_VIEW_HOMEWORK, PRIV.PRIV_USER_PROFILE);
    ctx.injectUI('UserDropdown', 'oi33_education_classes', { icon: 'group', displayName: '班型管理' }, (h: any) => isEducationCoach(h.user));
    // Keep old bookmarks working without a second, inconsistent student inbox.
    ctx.on('handler/before/EducationTasks#get', (h: any) => { h.get = h.redirectToHomework; });

    ctx.on('handler/before/HomeworkEdit#get', async (h: any) => {
        privatePage(h);
        assertEducationCoach(h.user);
        if (h.args.tid) await assertHomeworkManager(h, await ContestModel.get(h.domain._id, new ObjectId(h.args.tid)));
    });
    ctx.on('handler/after/HomeworkEdit#get', async (h: any) => {
        h.response.body.educationGroups = await listClassGroups(h.domain._id);
        if (!h.args.tid) Object.assign(h.response.body, homeworkDefaults(h.user.timeZone));
        h.response.body.extensionDays = 0;
        h.response.body.penaltyRules = '{}';
    });
    ctx.on('handler/before/HomeworkEdit#post', async (h: any) => {
        privatePage(h);
        assertEducationCoach(h.user);
        if (h.args.tid) await assertHomeworkManager(h, await ContestModel.get(h.domain._id, new ObjectId(h.args.tid)));
        if (h.args.operation !== 'update') return;
        // Checkbox arrays use a distinct field to avoid Hydro's string decorator.
        const names = normalizeClassNames(h.args.classNames ?? h.args.assign);
        const uids = await resolveClassStudents(h.domain._id, names);
        if (!uids.length) throw new ValidationError('班型', '所选班型尚无学生，不能发布空名单作业。');
        h.args.assign = names.join(',');
        h.request.body.assign = h.args.assign;
        h.oi33EducationDraft = { names, uids, creating: !h.args.tid };
        // Install on this handler instance after the native request lifecycle
        // (including CSRF and coach checks), before operation dispatch. Keeping
        // the native prototype untouched makes reloads and concurrent requests safe.
        h.oi33HomeworkNativeUpdate = h.postUpdate;
        h.postUpdate = HomeworkUpdateAdapter.prototype.postUpdate;
    });
    ctx.on('handler/after/HomeworkEdit#post', async (h: any) => {
        if (!h.oi33EducationDraft?.creating || !h.response.body?.tid) return;
        const { names, uids } = h.oi33EducationDraft;
        const tid = new ObjectId(h.response.body.tid);
        try {
            await createHomeworkRoster(h.domain._id, tid, names, uids, h.user._id);
        } catch (error) {
            // Hydro's creation and the addon snapshot do not share a transaction.
            // Never claim success or invite resubmitting the creation POST here.
            console.error('[oi33] homework roster creation needs recovery', tid.toString(), error);
            delete h.response.redirect;
            h.response.status = 503;
            h.response.template = 'oi33_education_recovery.html';
            h.response.body = { tid };
        }
    });
    ctx.on('handler/before/HomeworkFiles', async (h: any) => {
        privatePage(h);
        await assertHomeworkManager(h, h.tdoc);
    });
    ctx.on('handler/after/HomeworkDetail#get', async (h: any) => {
        if (h.user._id) privatePage(h);
        const tdoc = h.response.body?.tdoc;
        if (!tdoc) return;
        h.response.body.educationIsCoach = isEducationCoach(h.user);
        h.response.body.educationCanManage = isEducationCoach(h.user) && (isEducationAdmin(h.user) || h.user.own(tdoc))
            && h.user.hasPerm(h.user.own(tdoc) ? PERM.PERM_EDIT_HOMEWORK_SELF : PERM.PERM_EDIT_HOMEWORK);
    });
    ctx.on('handler/after/HomeworkMain#get', async (h: any) => {
        if (h.user._id) privatePage(h);
        h.response.body.educationIsCoach = isEducationCoach(h.user);
    });
}
