import { Context, Handler, PRIV, Types, param, requireSudo, ForbiddenError, ValidationError, RecordModel, UserModel, TokenModel, ObjectId, db } from 'hydrooj';
import { isEducationAdmin } from '../model/education-auth';
import { userColl } from '../model/user';
import {
    Enrollment, getEnrollment, enrollmentColl, ensureEnrollmentIndexes, submitEnrollment,
    reviewEnrollment, manageEnrollment, completeEnrollmentPasswordChange, completeEnrollmentNameReview,
} from '../model/enrollment';
import { decideEnrollmentAccess, enrollmentActivity, matchesContestScope } from '../model/enrollment-policy';
import { reviewEnrollmentName, NameReviewResult } from './enrollment-name-review';
import { isAccountAdmin, canResetStudentPassword, resetStudentPassword, acquirePasswordChange, releasePasswordChange, isOrdinaryStudentAccount } from '../model/account-password';

interface EnrollmentPretest { _id: ObjectId; uid: number; domainId: string; contestId: string; createdAt: Date }
declare module 'hydrooj' { interface Collections { oi33_enrollment_pretest: EnrollmentPretest } }
const pretestColl = db.collection('oi33_enrollment_pretest');

function domainOf(h: any): string { return h.domain?._id || h.context?.HydroContext?.domain?._id || h.args?.domainId || 'system'; }
function nameOf(h: any): string { return h.constructor.name.replace(/Handler$/, ''); }
function truthy(value: unknown) { return value === true || value === 1 || value === '1' || value === 'true'; }
function privateResponse(h: any) {
    h.response.addHeader('Cache-Control', 'private, no-store');
}

/** Account mutations are browser same-origin operations, even when Referer is omitted.
 * Use Koa's resolved protocol and host (including trusted reverse-proxy settings),
 * never an origin supplied through form fields, query parameters or CORS flags. */
export function requireAccountMutationOrigin(h: any) {
    const deny = () => { throw new ForbiddenError('无法确认请求来源，请从本站页面重新提交。'); };
    const headers = h.request.headers || {};
    const parse = (value: unknown, originOnly: boolean) => {
        if (typeof value !== 'string' || !/^https?:\/\//.test(value) || /[\s\\]/u.test(value)) return deny();
        try {
            const url = new URL(value);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
                || (originOnly && (url.pathname !== '/' || url.search || url.hash))) return deny();
            return url.origin;
        } catch { return deny(); }
    };
    // Koa 3's request.origin is the incoming Origin header, NOT the server origin.
    const expected = parse(`${h.context?.request?.protocol}://${h.context?.request?.host}`, true);
    const origin = headers.origin;
    const referer = headers.referer;
    const hasOrigin = origin !== undefined && origin !== '';
    const hasReferer = referer !== undefined && referer !== '';
    // Origin:null is not an absent header. Conflicting headers must not fall
    // back to a seemingly valid Referer. Missing both is fail-closed too.
    if (!hasOrigin && !hasReferer) return deny();
    if (hasOrigin && parse(origin, true) !== expected) return deny();
    if (hasReferer && parse(referer, false) !== expected) return deny();
    if (headers['sec-fetch-site'] !== undefined
        && !['same-origin', 'same-site', 'none'].includes(headers['sec-fetch-site'])) return deny();
}

function assertAccountAdmin(user: any) {
    if (!isAccountAdmin(user)) throw new ForbiddenError('仅 OJ 站点管理员可以进行实名审核与账号管理。');
}

// Wrap only this request's native password operation, retaining Hydro's current
// password verification, sudo, password validation and session invalidation.
export function installEnrollmentPasswordChange(h: any) {
    if (h.args.operation !== 'change_password' || h.__oi33PasswordChangeWrapped) return;
    requireAccountMutationOrigin(h);
    const original = h.postChangePassword;
    if (typeof original !== 'function') return;
    h.__oi33PasswordChangeWrapped = true;
    h.postChangePassword = async function (...args: any[]) {
        let lock;
        try { lock = await acquirePasswordChange(this.user._id); }
        catch { throw new ValidationError('password', null, '密码正在更新或账号状态已改变，请稍后刷新重试。'); }
        try {
            if (lock?.requiresPasswordChange && (this.args.password === '123456' || this.args.password === this.args.current)) {
                throw new ValidationError('password', null, '请设置不同于初始密码的新密码，不能继续使用 123456。');
            }
            const result = await original.apply(this, args);
            if (lock && this.response.redirect === this.url('user_login')) {
                await completeEnrollmentPasswordChange(this.user._id, lock.revision, lock.id);
            }
            return result;
        } finally {
            if (lock) await releasePasswordChange(this.user._id, lock.id);
        }
    };
}

async function recordAllowed(doc: Enrollment, h: any, rdoc: any): Promise<boolean> {
    if (!rdoc || rdoc.domainId !== domainOf(h) || rdoc.uid !== h.user._id) return false;
    if (matchesContestScope(doc, rdoc.domainId, String(rdoc.contest || ''))) return true;
    if (String(rdoc.contest) !== '000000000000000000000000') return false;
    const mapping = await pretestColl.findOne({ _id: rdoc._id, uid: h.user._id, domainId: domainOf(h) });
    return !!mapping && matchesContestScope(doc, mapping.domainId, mapping.contestId);
}

/** Called after Hydro's parallel handler/create listeners finish, before business prepare. */
export async function enforceEnrollment(h: any, websocket = false): Promise<'cleanup' | void> {
    if (!websocket && h.request.method.toLowerCase() === 'post'
        && ['Oi33EnrollmentReview', 'HomeSecurity'].includes(nameOf(h))) {
        // Runs before native sudo/operation dispatch can retain or replay args.
        requireAccountMutationOrigin(h);
    }
    const uid = h.user?._id;
    if (!uid || uid <= 0) return;
    const handler = nameOf(h);
    // Hydro merges query/body over args.domainId before loading the user's domain role.
    // Teaching administration must not accept a role loaded from another requested domain.
    if (/^(Oi33Enrollment|Education|AccountBatch|Homework)/.test(handler)
        && h.args.domainId && String(h.args.domainId) !== domainOf(h)) {
        throw new ForbiddenError('教学管理域与请求参数不一致，请使用该域的正式入口。');
    }
    const doc = await getEnrollment(uid);
    if (doc?.requiresPasswordChange) {
        const decision = decideEnrollmentAccess(doc, { uid, domainId: domainOf(h), handler,
            method: websocket ? 'ws' : h.request.method, operation: h.args.operation });
        if (!decision.allowed) {
            privateResponse(h);
            const accept = h.request.headers?.accept || '';
            if (!websocket && ['get', 'head'].includes(h.request.method.toLowerCase())
                && !h.request.json && !accept.includes('application/json') && !h.request.headers?.['x-requested-with']) {
                h.response.redirect = h.url('home_security');
                return 'cleanup';
            }
            throw new ForbiddenError(decision.reason || '请先修改初始密码。');
        }
    }
    const legacy = !doc ? await userColl.findOne({ _id: uid }, { projection: { realname_flag: 1 } }) : null;
    let recordInScope = false;
    if (doc?.accountType === 'temporary') {
        if (h.args.domainId && String(h.args.domainId) !== domainOf(h)) throw new ForbiddenError('比赛账号不能通过参数切换其他域。');
        if (handler === 'Home' && !websocket && ['get', 'head'].includes(h.request.method.toLowerCase())) {
            h.response.redirect = h.url('oi33_enrollment');
            return 'cleanup';
        }
        const tid = String(h.args.tid || '');
        if (['RecordList', 'RecordMainConnection'].includes(handler)) {
            recordInScope = matchesContestScope(doc, domainOf(h), tid)
                && !truthy(h.args.all) && !truthy(h.args.allDomain);
            // A temporary account never becomes a cross-contest record browser through filters.
            if (recordInScope) h.args.uidOrName = String(uid);
        } else if (['RecordDetail', 'RecordDetailConnection'].includes(handler) && /^[a-f\d]{24}$/i.test(String(h.args.rid || ''))) {
            recordInScope = await recordAllowed(doc, h, await RecordModel.get(domainOf(h), new ObjectId(String(h.args.rid))));
        }
    }
    const result = decideEnrollmentAccess(doc, {
        uid, domainId: domainOf(h), handler, method: websocket ? 'ws' : h.request.method,
        operation: h.args.operation, category: h.args.category, contestId: String(h.args.tid || ''), recordInScope,
        hasJudgePrivilege: !!h.user.hasPriv?.(PRIV.PRIV_JUDGE),
        isAdmin: isEducationAdmin(h.user) || (legacy?.realname_flag || 0) >= 2, legacyVerified: (legacy?.realname_flag || 0) >= 1,
    });
    if (!result.allowed) throw new ForbiddenError(`${result.reason} 入口：${h.url('oi33_enrollment')}`);
}

// WS has no before-prepare lifecycle event. Wrap its request-owned methods, not shared prototypes.
export function protectEnrollmentConnection(h: any) {
    const gateway = nameOf(h) === 'WebsocketEventsConnectionManager';
    // create/ws runs after Hydro authenticates the handshake. Never obtain this identity
    // from args, headers or later payloads: baseLayer's session inherits the token document.
    const handshakeUid = h.user?._id || 0;
    const handshakeIdentity = handshakeUid > 0 ? {
        uid: handshakeUid,
        credential: typeof h.session?._id === 'string' && h.session.uid === handshakeUid ? h.session._id : null,
    } : null;
    // Core's browser gateway can authenticate a payload credential without changing h.user.
    // Pin one browser identity to a connection and retain credentials only in this closure.
    // Trusted server gateways validate their secret in core prepare() and multiplex identities.
    let gatewayIdentity: { uid: number; credential: string } | null = null;
    let revoked = false;
    const assertOpen = () => {
        if (revoked) throw new ForbiddenError('登录连接已失效，请重新连接。');
    };
    const revoke = () => {
        if (revoked) return;
        revoked = true;
        h.close(4003, '账号权限或登录状态已改变，请重新连接。');
    };
    const trustedGateway = () => gateway && h.privileged === true;
    const checkSession = async (identity: { uid: number; credential: string | null }) => {
        if (!identity.credential) throw new ForbiddenError('登录凭据缺失，请重新登录。');
        const session = await TokenModel.get(identity.credential, TokenModel.TYPE_SESSION);
        const expiry = new Date(session?.expireAt).getTime();
        if (!session || session.uid !== identity.uid || !Number.isFinite(expiry) || expiry <= Date.now()) {
            throw new ForbiddenError('登录凭据已失效，请重新登录。');
        }
        assertOpen();
    };
    const checkCurrentIdentity = async () => {
        assertOpen();
        if (trustedGateway()) return;
        if ((h.user?._id || 0) !== handshakeUid) throw new ForbiddenError('连接身份已改变，请重新连接。');
        if (gatewayIdentity) {
            const user = await UserModel.getById('system', gatewayIdentity.uid);
            if (!user) throw new ForbiddenError('账号不存在。');
            const subject = Object.create(h);
            subject.user = user;
            await enforceEnrollment(subject, true);
        } else await enforceEnrollment(h, true);
        // Recheck the original token last, including when a reset and subsequent password
        // change both finished while this connection was idle. The enrollment flag alone
        // is not proof that the old login remains valid.
        if (handshakeIdentity) await checkSession(handshakeIdentity);
        if (gatewayIdentity) await checkSession(gatewayIdentity);
        assertOpen();
    };
    const checkGatewayCredential = async (payload: any) => {
        if (!gateway || trustedGateway() || !['subscribe', 'resume'].includes(payload?.operation)) return;
        if (payload.operation === 'resume') throw new ForbiddenError('普通连接不能恢复内部网关订阅。');
        if (!payload.credential) { await checkCurrentIdentity(); return; }
        if (typeof payload.credential !== 'string' || payload.credential.length > 4096) throw new ForbiddenError('登录凭据无效。');
        const session = await TokenModel.get(payload.credential, TokenModel.TYPE_SESSION);
        if (!session?.uid) throw new ForbiddenError('登录凭据无效或已过期。');
        if ((gatewayIdentity && (gatewayIdentity.uid !== session.uid || gatewayIdentity.credential !== payload.credential))
            || (handshakeIdentity && handshakeIdentity.uid !== session.uid)) {
            throw new ForbiddenError('同一浏览器连接不能混用不同用户身份，请重新连接。');
        }
        const user = await UserModel.getById('system', session.uid);
        if (!user) throw new ForbiddenError('账号不存在。');
        const subject = Object.create(h);
        subject.user = user;
        await enforceEnrollment(subject, true);
        await checkSession({ uid: session.uid, credential: payload.credential });
        // Two subscription requests can await authentication concurrently. Do not let the
        // later completion replace the identity already accepted by the first request.
        if (gatewayIdentity && (gatewayIdentity.uid !== session.uid || gatewayIdentity.credential !== payload.credential)) {
            throw new ForbiddenError('同一浏览器连接不能更换登录凭据，请重新连接。');
        }
        gatewayIdentity = { uid: session.uid, credential: payload.credential };
    };
    // Dynamic ctx.on callbacks (including user/message) do not pass __subscribe or message().
    // Gate the actual output too, serially, so revocation/expiry cannot leak queued notifications.
    let sends = Promise.resolve();
    const originalSend = h.send;
    if (typeof originalSend === 'function') h.send = function (...args: any[]) {
        sends = sends.then(async () => {
            try {
                await checkCurrentIdentity();
                return originalSend.apply(this, args);
            } catch {
                revoke();
            }
        });
        return sends;
    };
    for (const method of ['_prepare', 'prepare', 'message']) {
        const original = h[method];
        if (typeof original !== 'function' && method !== 'prepare') continue;
        h[method] = async function (...args: any[]) {
            if (gateway && method === 'prepare') {
                // Do not treat a mere gateway header as privileged: core must validate it first.
                try {
                    assertOpen();
                    const result = await original?.apply(this, args);
                    await checkCurrentIdentity();
                    return result;
                } catch (error) { revoke(); throw error; }
            }
            if (method === 'message') {
                try {
                    await checkCurrentIdentity();
                    await checkGatewayCredential(args[0]);
                    await checkCurrentIdentity();
                } catch {
                    // Core's onmessage exception handler logs the whole MessageEvent, which can
                    // contain the gateway credential. Close locally without throwing that event
                    // into core logging, and never run the original method after a policy denial.
                    revoke();
                    return;
                }
            } else {
                try { await checkCurrentIdentity(); }
                catch (error) { revoke(); throw error; }
            }
            return original?.apply(this, args);
        };
    }
    // message() and prepare() can invoke onRecordChange directly, outside @subscribe.
    // Protect those paths too, including queued updates which run after the original event.
    for (const method of ['onRecordChange', 'queueClear', 'sendUpdate']) {
        const original = h[method];
        if (typeof original !== 'function') continue;
        h[method] = async function (...args: any[]) {
            try {
                await checkCurrentIdentity();
                const doc = await getEnrollment(this.user?._id);
                if (doc?.accountType === 'temporary' && method !== 'queueClear' && !(await recordAllowed(doc, this, args[0]))) return;
                assertOpen();
                return original.apply(this, args);
            } catch { revoke(); }
        };
    }
    h.__subscribe = (h.__subscribe || []).map((subscription: any) => ({
        ...subscription,
        target: async function (...args: any[]) {
            try {
                await checkCurrentIdentity();
                const doc = await getEnrollment(this.user?._id);
                if (doc?.accountType === 'temporary' && subscription.name === 'record/change'
                    && !(await recordAllowed(doc, this, args[0]))) return;
                assertOpen();
                return subscription.target.apply(this, args);
            } catch (error: any) {
                revoke();
            }
        },
    }));
}

export class Oi33EnrollmentHandler extends Handler {
    async get() {
        privateResponse(this);
        const enrollment = await getEnrollment(this.user._id);
        const legacy = !enrollment ? await userColl.findOne({ _id: this.user._id }) : null;
        this.response.template = 'oi33_enrollment.html';
        this.response.body = { enrollment, legacyVerified: (legacy?.realname_flag || 0) >= 1,
            isAdmin: isEducationAdmin(this.user), canManageAccounts: isAccountAdmin(this.user),
            active: enrollment ? enrollmentActivity(enrollment) : null };
    }

    @param('realName', Types.String)
    @param('school', Types.String, true)
    @param('studentId', Types.String, true)
    @param('requestedGroups', Types.String, true)
    @param('revision', Types.UnsignedInt)
    async post(domainId: string, realName: string, school = '', studentId = '', requestedGroups = '', revision = 0) {
        privateResponse(this);
        await this.limitRate('enrollment_submit', 60, 3, '{{user}}');
        const legacy = await userColl.findOne({ _id: this.user._id });
        if (!await getEnrollment(this.user._id)) {
            if ((legacy?.realname_flag || 0) >= 1) throw new ForbiddenError('原有已核验身份继续有效，如需更正请联系管理员。');
            if (isEducationAdmin(this.user)) throw new ForbiddenError('管理员权限不等于实名认证，请由另一位管理员核验并建立身份档案；不能自行审批自己的身份。');
        }
        let submitted: Enrollment;
        try {
            submitted = await submitEnrollment(this.user._id, domainOf(this), { realName, school, studentId,
                requestedGroups: requestedGroups.split(/[,，\n]/).map((g) => g.trim()).filter(Boolean) }, revision);
        } catch (e: any) { throw new ValidationError('enrollment', e.message); }
        // A delayed submit can read back a newer revision: never review it on
        // behalf of the old request. No startup/login scans of historical users.
        if (submitted.revision === revision + 1 && submitted.status === 'pending'
            && submitted.realName === realName.trim() && submitted.domainId === domainOf(this)) {
            let result: NameReviewResult = { decision: 'review', reason: 'unavailable' };
            try {
                const current = await UserModel.getById(domainOf(this), this.user._id);
                if (!current) throw new Error('Missing applicant');
                if (isEducationAdmin(current)) result = { decision: 'review', reason: 'staff' };
                else {
                    try {
                        // Persistent Hydro counters bound cost even if students
                        // repeatedly resubmit or the service is restarted.
                        await this.limitRate('enrollment_name_user_daily', 86400, 6, '{{user}}');
                        await this.limitRate('enrollment_name_site_daily', 86400, 300, 'all');
                    } catch { result = { decision: 'review', reason: 'rate_limit' }; }
                    if (result.reason !== 'rate_limit') result = await reviewEnrollmentName(this.user._id, submitted.realName);
                }
                const latest = await UserModel.getById(domainOf(this), this.user._id);
                if (!latest) result = { decision: 'review', reason: 'unavailable' };
                else if (isEducationAdmin(latest)) result = { decision: 'review', reason: 'staff' };
            } catch { result = { decision: 'review', reason: 'unavailable' }; }
            // Name-only verdicts/errors never expose raw model output or secrets.
            // Database errors leave the authoritative pending record available
            // to the existing manual review page (no automatic rejection).
            try { await completeEnrollmentNameReview(submitted, result); }
            catch { console.warn('[oi33] enrollment name review persistence incomplete; inspect private review queue'); }
        }
        this.response.redirect = this.url('oi33_enrollment');
    }
}

export class Oi33EnrollmentReviewHandler extends Handler {
    async get() {
        assertAccountAdmin(this.user);
        privateResponse(this);
        const requestedPage = Math.max(1, Math.min(10000, Number.parseInt(this.args.page, 10) || 1));
        const rawName = this.args.name ?? '';
        if (typeof rawName !== 'string' || rawName.length > 160 || /[\u0000-\u001f\u007f]/.test(rawName)) {
            throw new ValidationError('name', '请填写有效的学生姓名。');
        }
        const filterName = rawName.trim();
        if (filterName.length > 80) throw new ValidationError('name', '姓名最多 80 字。');
        // Merge the non-approved views only; never change the stored review
        // decision or hide pending applications that still need a human.
        const filterStatus = this.args.status === 'approved' ? 'approved'
            : ['unapproved', 'pending', 'rejected'].includes(this.args.status) ? 'unapproved' : '';
        const filter: any = { domainId: domainOf(this) };
        if (filterStatus === 'approved') filter.status = 'approved';
        else if (filterStatus === 'unapproved') filter.status = { $in: ['pending', 'rejected'] };
        // Literal substring search, not user-supplied regex or a UID lookup.
        if (filterName) filter.realName = new RegExp(filterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const total = await enrollmentColl.countDocuments(filter);
        const pages = Math.max(1, Math.ceil(total / 30));
        const page = Math.min(requestedPage, pages);
        const enrollments = await enrollmentColl.find(filter).sort({ updatedAt: -1, _id: -1 }).skip((page - 1) * 30).limit(30).toArray();
        this.response.template = 'oi33_enrollment_review.html';
        const passwordResetAllowedUids = (await Promise.all(enrollments.map(async (entry) =>
            await canResetStudentPassword(domainOf(this), entry._id, this.user) ? entry._id : null)))
            .filter((uid) => uid !== null);
        this.response.body = { enrollments, page, pages, total, filterStatus, filterName, passwordResetAllowedUids };
    }

    @requireSudo
    async resetPassword(domainId: string, uid: number, revision: number) {
        assertAccountAdmin(this.user);
        await this.limitRate('oi33_reset_student_password', 3600, 60, '{{user}}');
        try { await resetStudentPassword(domainId, uid, revision, this.user); }
        catch (error) {
            if (error instanceof ForbiddenError) throw error;
            throw new ValidationError('password_reset', null, '密码重置未完成或账号状态已变化，请刷新页面后重试。');
        }
        const target = await getEnrollment(uid);
        this.response.redirect = this.url('oi33_enrollment_review', { query: { name: target?.realName || '' } });
    }

    @param('uid', Types.UnsignedInt)
    @param('revision', Types.UnsignedInt)
    @param('action', Types.String)
    @param('reason', Types.String, true)
    @param('validUntil', Types.String, true)
    async post(domainId: string, uid: number, revision: number, action: string, reason = '', validUntil = '') {
        assertAccountAdmin(this.user);
        privateResponse(this);
        requireAccountMutationOrigin(this);
        const target = await getEnrollment(uid);
        if (!target || target.domainId !== domainOf(this)) throw new ForbiddenError('不能管理其他域的身份档案。');
        if (uid === this.user._id) throw new ForbiddenError('不能审核或变更自己的账号状态，请由另一位管理员操作。');
        if (action === 'reset_password') return this.resetPassword(domainOf(this), uid, revision);
        if (action === 'disable' && isEducationAdmin(await UserModel.getById(domainOf(this), uid))) {
            throw new ForbiddenError('请先通过独立权限管理撤销管理员权限，再停用其账号，避免锁定管理入口。');
        }
        try {
            if (action === 'approve' || action === 'reject') {
                await reviewEnrollment(uid, revision, action === 'approve' ? 'approved' : 'rejected', this.user._id, reason);
            } else if (['disable', 'enable', 'extend', 'convert'].includes(action)) {
                // Require a timezone in administrative expiry input to avoid server-local time ambiguity.
                if (action === 'extend' && !/(Z|[+-]\d{2}:\d{2})$/.test(validUntil)) throw new Error('请使用带时区的时间，例如 2026-10-01T18:00:00+08:00。');
                await manageEnrollment(uid, revision, action as any, this.user._id,
                    validUntil ? { validUntil: new Date(validUntil) } : {});
            } else throw new Error('操作无效。');
        } catch (e: any) { throw new ValidationError('enrollment', e.message); }
        this.response.redirect = this.url('oi33_enrollment_review', { query: { name: target.realName } });
    }
}

export async function apply(ctx: Context) {
    await ensureEnrollmentIndexes();
    await pretestColl.createIndex({ uid: 1, domainId: 1, contestId: 1 });
    ctx.Route('oi33_enrollment', '/oi33/enrollment', Oi33EnrollmentHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_enrollment_review', '/oi33/enrollment/review', Oi33EnrollmentReviewHandler, PRIV.PRIV_USER_PROFILE);
    const events = ctx as any;
    events.on('handler/before-prepare', (h: any) => enforceEnrollment(h));
    events.on('handler/before-operation', (h: any) => enforceEnrollment(h));
    events.on('handler/create/ws', (h: any) => protectEnrollmentConnection(h));
    events.on('handler/after/ProblemSubmit#post', async (h: any) => {
        if (!truthy(h.args.pretest) || !h.response.body?.rid) return;
        const doc = await getEnrollment(h.user._id);
        if (doc?.accountType !== 'temporary' || !matchesContestScope(doc, domainOf(h), String(h.args.tid || ''))) return;
        const rid = new ObjectId(String(h.response.body.rid));
        await pretestColl.updateOne({ _id: rid }, { $setOnInsert: { uid: h.user._id, domainId: domainOf(h),
            contestId: String(h.args.tid), createdAt: new Date() } }, { upsert: true });
    });
    events.on('handler/before/HomeSecurity#post', (h: any) => installEnrollmentPasswordChange(h));
    events.on('oplog/log', (_type: string, h: any, args: any) => {
        if (nameOf(h) === 'HomeSecurity' && h.args.operation === 'change_password') delete args.current;
    });
    events.on('handler/after/HomeSecurity#get', async (h: any) => {
        if (h.response.template !== 'home_security.html' || h.response.redirect) return;
        if (!(await getEnrollment(h.user._id))?.requiresPasswordChange) return;
        privateResponse(h);
        h.response.template = 'oi33_password_change.html';
        h.response.body = { sudoUid: h.session?.sudoUid || null };
    });
    for (const name of ['UserRegisterWithCode', 'OauthCallback', 'UserLogin']) {
        events.on(`handler/after/${name}`, async (h: any) => {
            const uid = h.context?.HydroContext?.user?._id;
            if (!uid || !h.response.redirect) return;
            const doc = await getEnrollment(uid);
            const legacy = !doc ? await userColl.findOne({ _id: uid }, { projection: { realname_flag: 1 } }) : null;
            if (doc?.requiresPasswordChange) {
                // A successful password login has just verified the same student
                // credential (and configured MFA) that native sudo would ask for.
                // Do not grant this freshness to OAuth, GETs or staff accounts.
                if (name === 'UserLogin' && h.request.method.toLowerCase() === 'post'
                    && typeof h.args.password === 'string' && await isOrdinaryStudentAccount(domainOf(h), uid)) {
                    h.session.sudo = Date.now();
                    h.session.sudoArgs = null;
                }
                h.response.redirect = h.url('home_security');
            }
            else if (!doc && !(legacy?.realname_flag >= 1) && !isEducationAdmin(h.context.HydroContext.user)) h.response.redirect = h.url('oi33_enrollment');
            else if (doc && (!doc.enabled || doc.status !== 'approved' || doc.accountType === 'temporary')) h.response.redirect = h.url('oi33_enrollment');
        });
    }
}
