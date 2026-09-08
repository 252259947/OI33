import { randomBytes } from 'crypto';
import { ContestModel, db, DomainModel, ObjectId, UserModel, ValidationError } from 'hydrooj';
import { addLog } from './log';
import { classUnion, classifyTeachingStudents, extendRoster, exemptRoster, uniqueStudentIds } from './education-policy';
import type { RosterEntry } from './education-policy';
import { enrollmentColl } from './enrollment';

export interface HomeworkRoster {
    _id: ObjectId;
    domainId: string;
    tid: ObjectId;
    groups: string[];
    entries: RosterEntry[];
    revision: number;
    createdAt: Date;
    updatedAt: Date;
    operator: number;
}

interface HomeworkRosterPreview {
    _id: ObjectId;
    token: string;
    domainId: string;
    tid: ObjectId;
    operator: number;
    mode: string;
    groups: string[];
    entries: RosterEntry[];
    baseRevision: number;
    added: number[];
    exempted: number[];
    expiresAt: Date;
}

declare module 'hydrooj' {
    interface Collections {
        oi33_education_roster: HomeworkRoster;
        oi33_education_preview: HomeworkRosterPreview;
    }
}

export const educationRosterColl = db.collection('oi33_education_roster');
const previewColl = db.collection('oi33_education_preview');

export async function getTeachingStudentScope(domainId: string, uids: number[]) {
    const ids = uniqueStudentIds(uids);
    if (!ids.length) return classifyTeachingStudents(domainId, [], [], [], []);
    const [users, memberships, enrollments] = await Promise.all([
        UserModel.coll.find({ _id: { $in: ids } }).project({ _id: 1 }).toArray(),
        DomainModel.collUser.find({ domainId, uid: { $in: ids }, join: true }).project({ uid: 1, domainId: 1, join: 1 }).toArray(),
        enrollmentColl.find({ _id: { $in: ids } }).project({ _id: 1, domainId: 1, accountType: 1 }).toArray(),
    ]);
    return classifyTeachingStudents(domainId, ids, users.map((user) => user._id), memberships as any, enrollments as any);
}

async function requireTeachingStudents(domainId: string, uids: number[]) {
    const scope = await getTeachingStudentScope(domainId, uids);
    if (scope.missing.length) throw new ValidationError('学生 UID', null, `账号不存在：${scope.missing.join(', ')}。`);
    if (scope.outside.length) throw new ValidationError('班型成员', null, `以下 UID 不是本域正式成员或本域申请学生，请先完成入域流程：${scope.outside.join(', ')}。`);
    if (scope.temporary.length) throw new ValidationError('班型成员', null, `临时比赛账号不能进入教学班型或应交名单，请先清理这些 UID：${scope.temporary.join(', ')}。`);
    return scope.eligible;
}

export async function listClassGroups(domainId: string) {
    return (await UserModel.listGroup(domainId)).filter((group) => !/^\d+$/.test(group.name))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

export function normalizeClassNames(value: unknown): string[] {
    const values = Array.isArray(value) ? value : String(value || '').split(/[,，\n]/);
    const names = [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
    if (names.length > 100 || names.some((name) => name.length > 80 || /^\d+$/.test(name)
        || /[,，\r\n<>]/.test(name))) throw new ValidationError('班型', '班型名称不合法。');
    return names;
}

export async function resolveClassStudents(domainId: string, names: string[]) {
    if (!names.length) throw new ValidationError('班型', '请至少选择一个班型。');
    const groups = await listClassGroups(domainId);
    if (names.some((name) => !groups.some((group) => group.name === name))) {
        throw new ValidationError('班型', '班型不存在，请刷新后重新选择。');
    }
    return requireTeachingStudents(domainId, classUnion(groups.filter((group) => names.includes(group.name))));
}

export async function addStudentsToGroups(domainId: string, uids: number[], groups: string[], operator?: number) {
    const names = normalizeClassNames(groups);
    if (!names.length) return;
    const students = uniqueStudentIds(uids);
    await requireTeachingStudents(domainId, students);
    for (const name of names) {
        // Atomic add prevents concurrent imports from overwriting each other.
        await UserModel.collGroup.updateOne({ domainId, name }, { $addToSet: { uids: { $each: students } } }, { upsert: true });
    }
    UserModel._deleteUserCache(domainId);
    if (operator) await addLog({ type: 'education', action: 'class_add_students', operator, domainId, groups: names, uids: students } as any);
}

export async function setClassStudents(domainId: string, name: string, uids: number[], operator: number) {
    const names = normalizeClassNames([name]);
    if (names.length !== 1) throw new ValidationError('班型');
    const students = uniqueStudentIds(uids);
    await requireTeachingStudents(domainId, students);
    await UserModel.updateGroup(domainId, name, students);
    await addLog({ type: 'education', action: 'class_set_students', operator, domainId, groups: names, uids: students } as any);
}

export async function getHomeworkRoster(domainId: string, tid: ObjectId): Promise<HomeworkRoster | null> {
    return await educationRosterColl.findOne({ domainId, tid }) as any;
}

export async function createHomeworkRoster(domainId: string, tid: ObjectId, groups: string[], uids: number[], operator: number) {
    await requireTeachingStudents(domainId, uids);
    const now = new Date();
    const result = await educationRosterColl.updateOne({ domainId, tid }, { $setOnInsert: {
        domainId, tid, groups, entries: extendRoster([], uids, now), revision: 1, operator, createdAt: now, updatedAt: now,
    } }, { upsert: true });
    if (result.upsertedCount) await addLog({ type: 'education', action: 'roster_create', domainId, tid, operator, uids } as any);
    return getHomeworkRoster(domainId, tid);
}

export async function prepareRosterChange(
    domainId: string, tid: ObjectId, operator: number, mode: string, uids: number[], reason: string,
) {
    const tdoc = await ContestModel.get(domainId, tid);
    if (tdoc.rule !== 'homework') throw new ValidationError('作业');
    const roster = await getHomeworkRoster(domainId, tid);
    if (!['initialize', 'sync', 'add', 'exempt'].includes(mode)) throw new ValidationError('操作');
    if ((mode === 'initialize') !== !roster) throw new ValidationError('名单', '名单状态已变化，请刷新页面。');
    const groups = normalizeClassNames(tdoc.assign);
    const current = roster?.entries || [];
    let entries: RosterEntry[];
    if (mode === 'initialize' || mode === 'sync') entries = extendRoster(current, await resolveClassStudents(domainId, groups));
    else {
        const students = uniqueStudentIds(uids);
        if (!students.length || students.length !== new Set(uids).size) throw new ValidationError('学生 UID');
        if (mode === 'exempt' && students.some((uid) => !current.some((entry) => entry.uid === uid))) throw new ValidationError('学生 UID', '只能免除当前名单内的学生。');
        if (mode === 'add') {
            await requireTeachingStudents(domainId, students);
            const allowed = await resolveClassStudents(domainId, groups);
            if (students.some((uid) => !allowed.includes(uid))) throw new ValidationError('班型', '补发学生须先加入作业开放的班型。');
            entries = extendRoster(current, students);
        } else entries = exemptRoster(current, students, reason);
    }
    const token = randomBytes(24).toString('hex');
    const preview = { token, domainId, tid, operator, mode, groups, entries, baseRevision: roster?.revision || 0,
        added: entries.filter((entry) => !current.some((old) => old.uid === entry.uid)).map((entry) => entry.uid),
        exempted: entries.filter((entry) => entry.exemptAt && !current.find((old) => old.uid === entry.uid)?.exemptAt).map((entry) => entry.uid),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000) };
    await previewColl.insertOne(preview);
    return preview;
}

export async function confirmRosterChange(domainId: string, tid: ObjectId, operator: number, token: string) {
    const preview = await previewColl.findOne({ domainId, tid, operator, token, expiresAt: { $gt: new Date() } });
    if (!preview) throw new ValidationError('确认', '预览已过期，请重新预览。');
    // Eligibility can change while a preview is open; never create newly invalid obligations.
    await requireTeachingStudents(domainId, preview.added);
    const now = new Date();
    if (!preview.baseRevision) {
        if (await getHomeworkRoster(domainId, tid)) throw new ValidationError('名单', '名单已变化，请重新预览。');
        const result = await educationRosterColl.updateOne({ domainId, tid }, { $setOnInsert: {
            domainId, tid, groups: preview.groups, entries: preview.entries, revision: 1, operator, createdAt: now, updatedAt: now,
        } }, { upsert: true });
        if (!result.upsertedCount) throw new ValidationError('名单', '名单已变化，请重新预览。');
    } else {
        const result = await educationRosterColl.updateOne({ domainId, tid, revision: preview.baseRevision }, {
            $set: { entries: preview.entries, groups: preview.groups, operator, updatedAt: now }, $inc: { revision: 1 },
        });
        if (!result.modifiedCount) throw new ValidationError('名单', '名单已变化，请重新预览。');
    }
    await previewColl.deleteOne({ _id: preview._id });
    await addLog({ type: 'education', action: `roster_${preview.mode}`, domainId, tid, operator,
        added: preview.added, exempted: preview.exempted, revision: preview.baseRevision + 1 } as any);
}

export async function ensureEducationIndexes() {
    await educationRosterColl.createIndex({ domainId: 1, tid: 1 }, { unique: true });
    await educationRosterColl.createIndex({ domainId: 1, 'entries.uid': 1 });
    await previewColl.createIndex({ token: 1 }, { unique: true });
    await previewColl.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}
