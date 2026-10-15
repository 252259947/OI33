import { randomBytes } from 'crypto';
import { db, ForbiddenError, PRIV, pwsh, TokenModel, UserModel } from 'hydrooj';
import { Enrollment, enrollmentColl, getEnrollment } from './enrollment';
import { requireEnrollmentRevision } from './enrollment-policy';
import { addLog } from './log';
import { userColl } from './user';

const RESET_LEASE_MS = 5 * 60 * 1000;

export interface PasswordChangeLease { id: string; revision: number; requiresPasswordChange: boolean }

export async function acquirePasswordChange(uid: number): Promise<PasswordChangeLease | null> {
    const current = await getEnrollment(uid);
    if (!current) return null;
    if (current.passwordReset?.state === 'working') throw new Error('管理员正在重置密码，请稍后重试。');
    const now = new Date();
    const id = randomBytes(16).toString('hex');
    const result = await enrollmentColl.updateOne({ _id: uid, revision: current.revision,
        'passwordReset.state': { $ne: 'working' }, $or: [
            { passwordOperation: { $exists: false } }, { 'passwordOperation.leaseUntil': { $lte: now } },
        ] }, { $set: { passwordOperation: { id, kind: 'change', leaseUntil: new Date(now.getTime() + RESET_LEASE_MS) } } });
    if (!result.matchedCount) throw new Error('密码正在更新或账号已改变，请稍后刷新重试。');
    return { id, revision: current.revision, requiresPasswordChange: !!current.requiresPasswordChange };
}

export async function releasePasswordChange(uid: number, id: string): Promise<void> {
    await enrollmentColl.updateOne({ _id: uid, 'passwordOperation.id': id }, { $unset: { passwordOperation: '' } });
}

/** Domain ownership alone must never grant control of a global login password. */
export function isAccountAdmin(user: any): boolean {
    return Number.isSafeInteger(user?._id) && user._id > 0
        && (!!user.hasPriv?.(PRIV.PRIV_ALL) || Number(user.realname_flag || 0) >= 2);
}

async function isStudentTarget(domainId: string, uid: number, operator: any): Promise<boolean> {
    if (!isAccountAdmin(operator) || !Number.isSafeInteger(uid) || uid <= 0 || uid === operator._id) return false;
    const doc = await getEnrollment(uid);
    if (!doc || doc.domainId !== domainId || !doc.enabled || doc.accountType !== 'regular') return false;
    return isOrdinaryStudentAccount(domainId, uid);
}

/** A fresh student login must not grant sudo freshness to staff in any domain. */
export async function isOrdinaryStudentAccount(domainId: string, uid: number): Promise<boolean> {
    const target = await UserModel.getById(domainId, uid);
    if (!target || !['default', 'guest'].includes(target.role || 'default')) return false;
    const legacy = await userColl.findOne({ _id: uid });
    if (Number(legacy?.realname_flag || target.realname_flag || 0) >= 2 || target.hasPriv?.(PRIV.PRIV_ALL)) return false;
    // Conservative allowlist: judge workers and users with any additional
    // global administrative/read-secret capabilities are not student accounts.
    if (!Number.isSafeInteger(target.priv) || target.priv < 0 || (target.priv & ~PRIV.PRIV_DEFAULT) !== 0) return false;
    const staffMembership = await db.collection('domain.user').findOne({ uid,
        role: { $exists: true, $nin: ['', 'default', 'guest'] } });
    return !staffMembership;
}

export async function canResetStudentPassword(domainId: string, uid: number, operator: any): Promise<boolean> {
    return isStudentTarget(domainId, uid, operator);
}

/** Invalidate all login/recovery credentials without touching the user's data. */
export async function revokeStudentCredentials(uid: number): Promise<void> {
    await TokenModel.delByUid(uid);
    await db.collection('oi33_token').updateMany({ uid, isActive: true }, { $set: { isActive: false } });
    await db.collection('oi33_oauth_token').updateMany({ uid, isActive: true }, { $set: { isActive: false } });
    await db.collection('oi33_oauth_refresh').updateMany({ uid, isActive: true }, { $set: { isActive: false } });
    await db.collection('oi33_oauth_code').updateMany({ uid, consumed: false }, { $set: { consumed: true } });
}

export async function resetStudentPassword(
    domainId: string, uid: number, expectedRevision: number, operator: any,
): Promise<Enrollment> {
    if (!await isStudentTarget(domainId, uid, operator)) throw new ForbiddenError('仅 OJ 管理员可以重置本域普通学生账号的密码。');
    const current = await getEnrollment(uid);
    requireEnrollmentRevision(current!.revision, expectedRevision);
    // Snapshot credentials before claiming the lease. The password write itself
    // must be fenced: an expired worker must not overwrite a newer password.
    const credentials = await db.collection('user').findOne({ _id: uid }, {
        projection: { salt: 1, hash: 1, hashType: 1, priv: 1 },
    });
    if (!credentials || typeof credentials.salt !== 'string' || typeof credentials.hash !== 'string'
        || !Number.isSafeInteger(credentials.priv) || credentials.priv < 0 || (credentials.priv & ~PRIV.PRIV_DEFAULT) !== 0
        || typeof pwsh !== 'function' || typeof UserModel._deleteUserCache !== 'function') {
        throw new Error('账号密码服务暂不可用，未进行密码重置。');
    }
    const now = new Date();
    const reset = { id: randomBytes(16).toString('hex'), state: 'working' as const,
        startedAt: now, leaseUntil: new Date(now.getTime() + RESET_LEASE_MS), operator: operator._id };
    const revision = expectedRevision + 1;
    const claimed = await enrollmentColl.updateOne({ _id: uid, domainId, revision: expectedRevision,
        accountType: 'regular', enabled: true, $and: [{ $or: [
            { 'passwordReset.state': { $ne: 'working' } }, { 'passwordReset.leaseUntil': { $lte: now } },
        ] }, { $or: [
            { passwordOperation: { $exists: false } }, { 'passwordOperation.leaseUntil': { $lte: now } },
        ] }] }, { $set: { requiresPasswordChange: true, passwordReset: reset, updatedAt: now, revision,
        passwordOperation: { id: reset.id, kind: 'reset', leaseUntil: reset.leaseUntil } } });
    if (!claimed.matchedCount) throw new Error('账号已更新或正在重置密码，请刷新后重试。');
    let passwordWriteStarted = false;
    let credentialMismatch = false;
    try {
        // Set the server-side gate before changing credentials; failures leave
        // the account restricted. Never persist or audit the temporary password.
        if (!await isStudentTarget(domainId, uid, operator)) throw new ForbiddenError('账号权限已改变，已停止重置。');
        await revokeStudentCredentials(uid);
        const owned = await enrollmentColl.findOne({ _id: uid, 'passwordReset.id': reset.id,
            'passwordOperation.id': reset.id, 'passwordOperation.leaseUntil': { $gt: new Date() } });
        if (!owned) throw new Error('密码重置租约已过期，请重试。');
        const salt = randomBytes(32).toString('hex');
        const hash = await pwsh('123456', salt);
        if (typeof hash !== 'string' || !hash) throw new Error('密码生成失败。');
        if (!await enrollmentColl.findOne({ _id: uid, 'passwordReset.id': reset.id,
            'passwordOperation.id': reset.id, 'passwordOperation.leaseUntil': { $gt: new Date() } })) {
            throw new Error('密码重置租约已改变，未写入密码。');
        }
        passwordWriteStarted = true;
        // Hydro's native hash and cache invalidation are retained. Only its
        // unconditional write is replaced with an exact-credential CAS.
        const changed = await db.collection('user').findOneAndUpdate({ _id: uid,
            salt: credentials.salt, hash: credentials.hash,
            hashType: credentials.hashType === undefined ? { $exists: false } : credentials.hashType,
            priv: credentials.priv }, { $set: { salt, hash, hashType: 'hydro' } }, { returnDocument: 'after' });
        if (!changed) {
            credentialMismatch = true;
            throw new Error('账号密码或权限已改变，未覆盖新密码。');
        }
        UserModel._deleteUserCache(changed);
        // Close sessions created during the password write as well.
        await revokeStudentCredentials(uid);
        const finished = await enrollmentColl.updateOne({ _id: uid, 'passwordReset.id': reset.id,
            'passwordOperation.id': reset.id,
            'passwordReset.state': 'working', requiresPasswordChange: true }, {
            $set: { 'passwordReset.state': 'ready', updatedAt: new Date() },
            $push: { history: { revision, action: 'password_reset', operator: operator._id, at: new Date() } },
        });
        if (!finished.matchedCount) throw new Error('密码重置状态已改变，请由管理员重新确认。');
        await addLog({ type: 'admin', action: 'enrollment_password_reset', userId: uid,
            operator: operator._id, reason: `revision:${revision}` });
        return (await getEnrollment(uid))!;
    } catch {
        // An ambiguous database write must fail closed. A confirmed credential
        // CAS miss did not change any password and must not disturb a newer
        // successful reset/change. Revision fencing rejects old success hooks.
        if (passwordWriteStarted && !credentialMismatch) await enrollmentColl.updateOne({ _id: uid, requiresPasswordChange: { $ne: true } }, {
            $set: { requiresPasswordChange: true, updatedAt: new Date() }, $inc: { revision: 1 },
        });
        await enrollmentColl.updateOne({ _id: uid, 'passwordReset.id': reset.id }, {
            $set: { requiresPasswordChange: true, 'passwordReset.state': 'failed', updatedAt: new Date() },
            $push: { history: { revision, action: 'password_reset_failed', operator: operator._id, at: new Date() } },
        });
        await addLog({ type: 'admin', action: 'enrollment_password_reset_failed', userId: uid,
            operator: operator._id, reason: `revision:${revision}` });
        throw new Error('密码重置未完成，账号仍需修改密码；请刷新页面后重试。');
    } finally {
        await releasePasswordChange(uid, reset.id);
    }
}
