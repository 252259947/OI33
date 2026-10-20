import { Context, ContestModel, DomainModel, ForbiddenError, Handler, ObjectId, param, PERM, PRIV, Types, UserModel, ValidationError } from 'hydrooj';
import { assertEducationCoach, isEducationAdmin, isEducationCoach } from '../model/education-auth';
import { getHomeworkRoster, getTeachingStudentScope, listClassGroups } from '../model/education';
import { uniqueStudentIds } from '../model/education-policy';
import { enrollmentColl } from '../model/enrollment';
import { userColl } from '../model/user';
import { rosterNames } from './education';

/** Names stay behind the teaching permission check; this is not a public user search. */
export async function findTeachingStudents(domainId: string, query: string, allowed?: number[], includeInactive = false) {
    let ids = allowed;
    if (!ids) {
        const [members, enrolled] = await Promise.all([
            DomainModel.collUser.find({ domainId, join: true }).project({ uid: 1 }).toArray(),
            enrollmentColl.find({ domainId }).project({ _id: 1 }).toArray(),
        ]);
        ids = uniqueStudentIds([...members.map((doc) => doc.uid), ...enrolled.map((doc) => doc._id)]);
    }
    const scope = await getTeachingStudentScope(domainId, ids);
    ids = includeInactive ? scope.inDomain : scope.eligible;
    if (!ids.length) return { students: [], more: false };
    // Escape the query: names are literal text, never user-supplied regular expressions.
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const [enrolled, legacy, accounts] = await Promise.all([
        enrollmentColl.find({ domainId, _id: { $in: ids }, realName: pattern }).project({ _id: 1 }).limit(100).toArray(),
        userColl.find({ _id: { $in: ids }, realname_name: pattern } as any).project({ _id: 1 }).limit(100).toArray(),
        UserModel.coll.find({ _id: { $in: ids }, uname: pattern }).project({ _id: 1 }).limit(100).toArray(),
    ]);
    const matches = uniqueStudentIds([...enrolled, ...legacy, ...accounts].map((doc) => doc._id));
    const [names, users, identities, enrollments] = await Promise.all([
        rosterNames(domainId, matches), UserModel.getList(domainId, matches),
        userColl.find({ _id: { $in: matches } } as any).project({ _id: 1, realname_flag: 1 }).toArray(),
        enrollmentColl.find({ _id: { $in: matches } }).project({ _id: 1, enabled: 1, accountType: 1 }).toArray(),
    ]);
    const candidates = matches.filter((uid) => {
        if (!users[uid]) return false;
        if (includeInactive) return true; // Existing obligations can still be exempted.
        const enrollment = enrollments.find((doc) => doc._id === uid);
        return enrollment?.enabled !== false && enrollment?.accountType !== 'temporary'
            && !isEducationCoach(users[uid])
            && Number(identities.find((doc) => doc._id === uid)?.realname_flag || 0) < 2;
    }).map((uid) => ({ uid, name: names[uid], username: users[uid].uname }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.uid - b.uid);
    return { students: candidates.slice(0, 30), more: candidates.length > 30 || Math.max(enrolled.length, legacy.length, accounts.length) === 100 };
}

export class EducationStudentsHandler extends Handler {
    async prepare() {
        this.response.addHeader('Cache-Control', 'private, no-store');
        if (!this.domain?._id || (this.args.domainId && this.args.domainId !== this.domain._id)) throw new ForbiddenError();
        assertEducationCoach(this.user);
    }

    @param('q', Types.String, true)
    @param('tid', Types.ObjectId, true)
    @param('mode', Types.String, true)
    async get(_domainId: string, q = '', tid?: ObjectId, mode = '') {
        const domainId = this.domain._id;
        if (q.length > 80) throw new ValidationError('学生姓名');
        let allowed: number[] | undefined;
        if (tid) {
            const tdoc = await ContestModel.get(domainId, tid);
            if (tdoc.rule !== 'homework' || (!isEducationAdmin(this.user) && !this.user.own(tdoc))) throw new ForbiddenError();
            this.checkPerm(this.user.own(tdoc) ? PERM.PERM_EDIT_HOMEWORK_SELF : PERM.PERM_EDIT_HOMEWORK);
            if (!['add', 'exempt'].includes(mode)) throw new ValidationError('操作');
            if (mode === 'exempt') {
                allowed = (await getHomeworkRoster(domainId, tid))?.entries.filter((entry) => !entry.exemptAt).map((entry) => entry.uid) || [];
            } else {
                allowed = uniqueStudentIds((await listClassGroups(domainId))
                    .filter((group) => tdoc.assign?.includes(group.name)).flatMap((group) => group.uids));
            }
        } else if (mode) throw new ValidationError('操作');
        this.response.body = await findTeachingStudents(domainId, q.trim(), allowed, mode === 'exempt');
    }
}

export function apply(ctx: Context) {
    ctx.Route('oi33_education_students', '/oi33/education/students', EducationStudentsHandler, PRIV.PRIV_USER_PROFILE);
}
