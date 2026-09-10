import { db } from 'hydrooj';
import { addLog } from './log';
import { userColl } from './user';
import { ContestScope, EnrollmentAccess, EnrollmentAccountType, requireEnrollmentRevision } from './enrollment-policy';

export interface Enrollment extends EnrollmentAccess {
    _id: number;
    domainId: string;
    realName: string;
    school?: string;
    studentId?: string;
    requestedGroups: string[];
    revision: number;
    createdAt: Date;
    updatedAt: Date;
    submittedAt?: Date;
    reviewedAt?: Date;
    reviewedBy?: number;
    rejectionReason?: string;
    batchId?: string;
    rosterKey?: string;
    requiresPasswordChange?: boolean;
    history: { revision: number; action: string; operator: number; at: Date; reason?: string }[];
}
export interface EnrollmentInput {
    realName: string;
    school?: string;
    studentId?: string;
    requestedGroups?: string[];
}
export interface ProvisionEnrollmentInput extends EnrollmentInput {
    uid: number;
    domainId: string;
    accountType?: EnrollmentAccountType;
    validFrom?: Date;
    validUntil?: Date;
    contestScopes?: ContestScope[];
    batchId?: string;
    rosterKey?: string;
    requiresPasswordChange?: boolean;
}
declare module 'hydrooj' { interface Collections { oi33_enrollment: Enrollment } }
export const enrollmentColl = db.collection('oi33_enrollment');

function cleanText(value: unknown, max: number, required = false): string {
    if (value !== undefined && typeof value !== 'string') throw new Error('资料格式错误。');
    const result = ((value || '') as string).trim();
    if ((required && !result) || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) {
        throw new Error(required ? '请填写真实姓名（1 至 80 字），不要使用控制字符。' : '资料长度或格式不正确。');
    }
    return result;
}

export function normalizeEnrollmentInput(input: EnrollmentInput): EnrollmentInput & { requestedGroups: string[] } {
    if (input.requestedGroups !== undefined && (!Array.isArray(input.requestedGroups) || input.requestedGroups.length > 30)) {
        throw new Error('申请班型数量过多或格式错误。');
    }
    return {
        realName: cleanText(input.realName, 80, true),
        school: cleanText(input.school, 120),
        studentId: cleanText(input.studentId, 80),
        requestedGroups: [...new Set((input.requestedGroups || []).map((g) => cleanText(g, 80, true)))],
    };
}

export function validateTemporaryScope(input: Pick<ProvisionEnrollmentInput, 'accountType' | 'validFrom' | 'validUntil' | 'contestScopes'>) {
    if (input.accountType !== undefined && !['regular', 'temporary'].includes(input.accountType)) throw new Error('账号类型无效。');
    for (const date of [input.validFrom, input.validUntil]) {
        if (date !== undefined && (!(date instanceof Date) || !Number.isFinite(date.getTime()))) throw new Error('账号有效期无效。');
    }
    if (input.validUntil && input.validFrom && input.validUntil <= input.validFrom) throw new Error('结束时间必须晚于开始时间。');
    const scopes = input.contestScopes || [];
    if (!Array.isArray(scopes) || scopes.length > 100 || scopes.some((s) => !s.domainId || !/^[a-f\d]{24}$/i.test(s.contestId))) {
        throw new Error('比赛范围无效。');
    }
    if (input.accountType === 'temporary' && (!input.validUntil || !scopes.length)) throw new Error('临时账号必须指定到期时间及比赛。');
}

export async function getEnrollment(uid: number): Promise<Enrollment | null> {
    return enrollmentColl.findOne({ _id: uid });
}

// The enrollment document is authoritative. This flag is only for legacy UI/feature compatibility.
// Do not copy names into public User data or downgrade pre-existing administrator flags.
async function syncVerifiedFlag(uid: number, verified: boolean, revision: number) {
    const fields = { realname_flag: verified ? 1 : 0, realname_enrollment_revision: revision };
    const current = await userColl.findOne({ _id: uid });
    if (!current) {
        try { await userColl.insertOne({ _id: uid, ...fields } as any); }
        catch (e: any) { if (e?.code !== 11000) throw e; }
    }
    // Enrollment writes are revision-guarded, but their follow-up compatibility
    // writes can complete out of order. Never let a delayed submit clear approval.
    await userColl.updateOne({ _id: uid, $and: [
        { $or: [{ realname_flag: { $lt: 2 } }, { realname_flag: { $exists: false } }] },
        { $or: [{ realname_enrollment_revision: { $lte: revision } },
            { realname_enrollment_revision: { $exists: false } }] },
    ] }, { $set: fields });
}

async function audit(uid: number, operator: number, action: string, revision: number) {
    // Public activity logs must not contain private names, student IDs, or review reasons.
    await addLog({ type: 'admin', userId: uid, operator, action: `enrollment_${action}`, reason: `revision:${revision}` });
}

export async function submitEnrollment(uid: number, domainId: string, input: EnrollmentInput, expectedRevision: number): Promise<Enrollment> {
    const clean = normalizeEnrollmentInput(input);
    const old = await getEnrollment(uid);
    requireEnrollmentRevision(old?.revision || 0, expectedRevision);
    if (old && (old.status === 'approved' || old.accountType !== 'regular' || !old.enabled)) {
        throw new Error('已审核、临时或停用账号不能自行修改身份资料，请联系教练。');
    }
    if (old && old.domainId !== domainId) throw new Error('请返回原申请域修改资料。');
    const now = new Date();
    const revision = expectedRevision + 1;
    const event = { revision, action: 'submit', operator: uid, at: now };
    if (old) {
        const result = await enrollmentColl.updateOne({ _id: uid, revision: expectedRevision, enabled: true, status: { $in: ['pending', 'rejected'] } }, {
            $set: { ...clean, status: 'pending', updatedAt: now, submittedAt: now, revision },
            $unset: { rejectionReason: '', reviewedAt: '', reviewedBy: '' }, $push: { history: event },
        });
        if (!result.matchedCount) throw new Error('申请已变更，请刷新页面。');
    } else {
        try {
            await enrollmentColl.insertOne({ _id: uid, domainId, ...clean, status: 'pending', accountType: 'regular',
                enabled: true, contestScopes: [], revision, createdAt: now, updatedAt: now, submittedAt: now, history: [event] });
        } catch (e: any) {
            if (e?.code === 11000) throw new Error('申请已提交，请刷新页面。');
            throw e;
        }
    }
    await syncVerifiedFlag(uid, false, revision);
    await audit(uid, uid, 'submit', revision);
    return (await getEnrollment(uid))!;
}

export async function reviewEnrollment(uid: number, expectedRevision: number, decision: 'approved' | 'rejected', operatorUid: number, reason = ''): Promise<Enrollment> {
    if (!['approved', 'rejected'].includes(decision)) throw new Error('审核结果无效。');
    requireEnrollmentRevision(expectedRevision, expectedRevision);
    const rejectionReason = cleanText(reason, 1000);
    if (decision === 'rejected' && !rejectionReason) throw new Error('退回申请时必须填写原因。');
    const now = new Date();
    const revision = expectedRevision + 1;
    const result = await enrollmentColl.updateOne({ _id: uid, revision: expectedRevision, status: 'pending', enabled: true }, {
        $set: { status: decision, reviewedBy: operatorUid, reviewedAt: now, updatedAt: now, rejectionReason, revision },
        $push: { history: { revision, action: decision, operator: operatorUid, at: now, reason: rejectionReason } },
    });
    if (!result.matchedCount) throw new Error('申请已更新或已被处理，请刷新后重新审核。');
    await syncVerifiedFlag(uid, decision === 'approved', revision);
    await audit(uid, operatorUid, decision, revision);
    return (await getEnrollment(uid))!;
}

export async function provisionEnrollment(input: ProvisionEnrollmentInput, operatorUid: number): Promise<Enrollment> {
    const clean = normalizeEnrollmentInput(input);
    validateTemporaryScope(input);
    if (!Number.isSafeInteger(input.uid) || input.uid <= 0 || !input.domainId) throw new Error('账号或域无效。');
    const now = new Date();
    const candidate: Enrollment = { _id: input.uid, domainId: input.domainId, ...clean, status: 'approved',
        accountType: input.accountType || 'regular', enabled: true, contestScopes: input.contestScopes || [],
        revision: 1, createdAt: now, updatedAt: now, reviewedAt: now, reviewedBy: operatorUid,
        history: [{ revision: 1, action: 'provision', operator: operatorUid, at: now }],
        ...input.validFrom ? { validFrom: input.validFrom } : {}, ...input.validUntil ? { validUntil: input.validUntil } : {},
        ...input.batchId ? { batchId: input.batchId } : {}, ...input.rosterKey ? { rosterKey: input.rosterKey } : {},
        requiresPasswordChange: !!input.requiresPasswordChange,
    };
    try { await enrollmentColl.insertOne(candidate); }
    catch (e: any) {
        if (e?.code !== 11000) throw e;
        const old = await getEnrollment(input.uid);
        const same = old && input.batchId && input.rosterKey && old.batchId === input.batchId && old.rosterKey === input.rosterKey
            && old.domainId === input.domainId && old.realName === candidate.realName && old.studentId === candidate.studentId
            && old.school === candidate.school && old.accountType === candidate.accountType && old.status === 'approved'
            && old.enabled && old.revision === 1
            && !!old.requiresPasswordChange === !!candidate.requiresPasswordChange
            && String(old.validFrom || '') === String(candidate.validFrom || '') && String(old.validUntil || '') === String(candidate.validUntil || '')
            && JSON.stringify(old.contestScopes) === JSON.stringify(candidate.contestScopes)
            && JSON.stringify(old.requestedGroups) === JSON.stringify(candidate.requestedGroups);
        if (!same) throw new Error('该账号已有身份档案，不能通过导入覆盖，请在账号管理中处理。');
        await syncVerifiedFlag(input.uid, true, old.revision);
        return old;
    }
    await syncVerifiedFlag(input.uid, true, candidate.revision);
    await audit(input.uid, operatorUid, 'provision', 1);
    return candidate;
}

export async function manageEnrollment(uid: number, expectedRevision: number, action: 'disable' | 'enable' | 'extend' | 'convert', operatorUid: number, options: { validUntil?: Date } = {}): Promise<Enrollment> {
    const old = await getEnrollment(uid);
    if (!old) throw new Error('身份档案不存在。');
    requireEnrollmentRevision(old.revision, expectedRevision);
    if (!['disable', 'enable', 'extend', 'convert'].includes(action)) throw new Error('操作无效。');
    const now = new Date();
    const revision = old.revision + 1;
    const update: any = { $set: { updatedAt: now, revision },
        $push: { history: { revision, action, operator: operatorUid, at: now } } };
    if (action === 'disable' || action === 'enable') update.$set.enabled = action === 'enable';
    else {
        if (old.status !== 'approved') throw new Error('仅已审核账号可以延期或转为正式账号。');
        if (old.accountType !== 'temporary') throw new Error('此操作仅适用于临时账号。');
        if (action === 'extend') {
            if (!(options.validUntil instanceof Date) || !Number.isFinite(options.validUntil.getTime())
                || options.validUntil <= now || (old.validUntil && options.validUntil <= new Date(old.validUntil))) throw new Error('延期时间必须晚于当前时间及原到期时间。');
            update.$set.validUntil = options.validUntil;
        } else {
            update.$set.accountType = 'regular';
            update.$set.contestScopes = [];
            update.$unset = { validFrom: '', validUntil: '' };
        }
    }
    const result = await enrollmentColl.updateOne({ _id: uid, revision: expectedRevision }, update);
    if (!result.matchedCount) throw new Error('账号状态已改变，请刷新后重试。');
    await audit(uid, operatorUid, action, revision);
    return (await getEnrollment(uid))!;
}

export async function ensureEnrollmentIndexes() {
    await enrollmentColl.createIndex({ domainId: 1, status: 1, updatedAt: -1 });
    await enrollmentColl.createIndex({ batchId: 1, rosterKey: 1 }, { unique: true,
        partialFilterExpression: { batchId: { $type: 'string' }, rosterKey: { $type: 'string' } } });
}

// Call only from Hydro's successful password-change after hook, never from request arguments.
export async function completeEnrollmentPasswordChange(uid: number) {
    const old = await getEnrollment(uid);
    if (!old?.requiresPasswordChange) return;
    const now = new Date();
    const result = await enrollmentColl.updateOne({ _id: uid, revision: old.revision, requiresPasswordChange: true }, {
        $set: { requiresPasswordChange: false, updatedAt: now }, $inc: { revision: 1 },
        $push: { history: { revision: old.revision + 1, action: 'password_changed', operator: uid, at: now } },
    });
    if (result.matchedCount) await audit(uid, uid, 'password_changed', old.revision + 1);
}
