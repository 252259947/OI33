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

let classNameIndexReady: Promise<unknown> | undefined;
async function requireClassNameIndex() {
    // Hydro only initializes core indexes in worker 0. Confirm this required
    // invariant before an insert even on a fresh database or another worker.
    try {
        classNameIndexReady ||= UserModel.collGroup.createIndex({ domainId: 1, name: 1 }, { name: 'name', unique: true });
        await classNameIndexReady;
    } catch {
        classNameIndexReady = undefined;
        throw new ValidationError('班型', null, '暂时无法保证班型名称唯一，请联系管理员；原名单未改变。');
    }
}

export async function createClassStudents(domainId: string, name: string, uids: number[], operator: number) {
    const names = normalizeClassNames([name]);
    if (names.length !== 1) throw new ValidationError('班型');
    const students = uniqueStudentIds(uids);
    await requireTeachingStudents(domainId, students);
    await requireClassNameIndex();
    try {
        // Hydro maintains a unique (domainId, name) index. insertOne cannot
        // replace a roster, including when two teachers create it concurrently.
        await UserModel.collGroup.insertOne({ domainId, name: names[0], uids: students });
    } catch (error) {
        if (error?.code === 11000) throw new ValidationError('班型', null, '同名班型已存在，请使用下方“编辑班型成员”；原名单未改变。');
        throw error;
    }
    UserModel._deleteUserCache(domainId);
    await addLog({ type: 'education', action: 'class_create', operator, domainId, groups: names, uids: students } as any);
}

export async function setClassStudents(domainId: string, name: string, uids: number[], operator: number, originalUids?: number[], allowEmpty = false) {
    const names = normalizeClassNames([name]);
    if (names.length !== 1) throw new ValidationError('班型');
    const students = uniqueStudentIds(uids);
    await requireTeachingStudents(domainId, students);
    if (!Array.isArray(originalUids)) throw new ValidationError('班型', null, '请刷新班型管理页后重新编辑。');
    const original = uniqueStudentIds(originalUids);
    if (original.length && !students.length && !allowEmpty) throw new ValidationError('班型', null, '清空名单需要勾选“确认清空本班型名单”；原名单未改变。');
    const result = await UserModel.collGroup.updateOne({ domainId, name: names[0],
        uids: original.length ? { $all: original, $size: original.length } : { $size: 0 },
    }, { $set: { uids: students } });
    if (!result.matchedCount) throw new ValidationError('班型', null, '班型已删除或名单已被其他操作修改，请刷新后重试；本次未覆盖名单。');
    UserModel._deleteUserCache(domainId);
    await addLog({ type: 'education', action: 'class_set_students', operator, domainId, groups: names, uids: students } as any);
}

export interface ClassReferences {
    documents: number;
    joinSettings: number;
    previews: number;
    batches: number;
    total: number;
}

// Names are native access-control keys. Never remove them from assign arrays:
// an empty assign means public in Hydro. Historical roster snapshots are not
// access grants and deliberately retain their original names and student rows.
export async function getClassReferenceSummaries(domainId: string, names: string[]) {
    const result: Record<string, ClassReferences> = Object.create(null);
    for (const name of names) result[name] = { documents: 0, joinSettings: 0, previews: 0, batches: 0, total: 0 };
    if (!names.length) return result;
    const now = new Date();
    const [documents, domain, previews, batches] = await Promise.all([
        db.collection<any>('document').find({ domainId, assign: { $in: names } }).project({ assign: 1 }).toArray(),
        DomainModel.coll.findOne({ _id: domainId }, { projection: { _join: 1, joinSettings: 1 } }),
        previewColl.find({ domainId, groups: { $in: names }, expiresAt: { $gt: now } }).project({ groups: 1 }).toArray(),
        db.collection<any>('oi33_account_batch').find({ domainId, groups: { $in: names }, $or: [
            { status: 'preview', expiresAt: { $gt: now } }, { status: { $in: ['processing', 'partial'] } },
        ] }).project({ groups: 1 }).toArray(),
    ]);
    const count = (rows: any[], field: string, category: keyof Omit<ClassReferences, 'total'>) => {
        for (const row of rows) {
            const values = Array.isArray(row[field]) ? row[field] : [row[field]];
            for (const name of new Set(values)) if (Object.prototype.hasOwnProperty.call(result, name)) result[name][category]++;
        }
    };
    count(documents, 'assign', 'documents');
    count(previews, 'groups', 'previews');
    count(batches, 'groups', 'batches');
    for (const name of new Set([domain?._join?.group, (domain as any)?.joinSettings?.group])) {
        if (typeof name === 'string' && Object.prototype.hasOwnProperty.call(result, name)) result[name].joinSettings = 1;
    }
    for (const refs of Object.values(result)) refs.total = refs.documents + refs.joinSettings + refs.previews + refs.batches;
    return result;
}

function className(value: string) {
    const names = normalizeClassNames([value]);
    if (names.length !== 1) throw new ValidationError('班型', null, '请输入有效的班型名称。');
    return names[0];
}

function classSnapshot(domainId: string, groupId: ObjectId, name: string, originalUids?: number[]) {
    if (!(groupId instanceof ObjectId) || !Array.isArray(originalUids)) {
        throw new ValidationError('班型', null, '请刷新班型管理页后重新操作。');
    }
    const original = uniqueStudentIds(originalUids);
    return { _id: groupId, domainId, name,
        uids: original.length ? { $all: original, $size: original.length } : { $size: 0 } };
}

async function requireUnusedClass(domainId: string, name: string, description = '该班型') {
    const refs = (await getClassReferenceSummaries(domainId, [name]))[name];
    if (!refs.total) return;
    const details = [refs.documents && `作业、比赛或讨论 ${refs.documents} 项`, refs.joinSettings && '入域设置 1 项',
        refs.previews && `作业名单预览 ${refs.previews} 项`, refs.batches && `账号导入批次 ${refs.batches} 项`].filter(Boolean).join('，');
    throw new ValidationError('班型', null, `${description}仍被引用（${details}），请先调整相关设置再操作；原班型和名单未改变。`);
}

export async function renameClassGroup(domainId: string, groupId: ObjectId, name: string, newName: string, operator: number, originalUids?: number[]) {
    const previousName = className(name);
    const nextName = className(newName);
    const filter = classSnapshot(domainId, groupId, previousName, originalUids);
    if (!await UserModel.collGroup.findOne(filter)) throw new ValidationError('班型', null, '班型已删除、改名或名单已变化，请刷新后重试。');
    if (nextName === previousName) return;
    await requireUnusedClass(domainId, previousName);
    // A previously deleted name may still be an access key in legacy data.
    // Do not attach this class's students to those unrelated obligations.
    await requireUnusedClass(domainId, nextName, '新班型名称');
    await requireClassNameIndex();
    try {
        const result = await UserModel.collGroup.updateOne(filter, { $set: { name: nextName } });
        if (!result.matchedCount) throw new ValidationError('班型', null, '班型已删除、改名或名单已变化，请刷新后重试；本次未修改。');
    } catch (error) {
        if (error?.code === 11000) throw new ValidationError('班型', null, '同名班型已存在，请使用其他名称；原班型和名单未改变。');
        throw error;
    }
    UserModel._deleteUserCache(domainId);
    await addLog({ type: 'education', action: 'class_rename', operator, domainId,
        groups: [previousName, nextName], groupId } as any);
}

export async function deleteClassGroup(domainId: string, groupId: ObjectId, name: string, operator: number, originalUids?: number[], confirmDelete = false) {
    if (confirmDelete !== true) throw new ValidationError('删除班型', null, '请先确认删除班型。');
    const previousName = className(name);
    const filter = classSnapshot(domainId, groupId, previousName, originalUids);
    if (!await UserModel.collGroup.findOne(filter)) throw new ValidationError('班型', null, '班型已删除、改名或名单已变化，请刷新后重试。');
    await requireUnusedClass(domainId, previousName);
    const result = await UserModel.collGroup.deleteOne(filter);
    if (!result.deletedCount) throw new ValidationError('班型', null, '班型已删除、改名或名单已变化，请刷新后重试；本次未删除。');
    UserModel._deleteUserCache(domainId);
    await addLog({ type: 'education', action: 'class_delete', operator, domainId, groups: [previousName], groupId } as any);
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
