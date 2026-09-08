import { Context, Handler, PRIV, Types, param, ForbiddenError, ValidationError, RecordModel, UserModel, TokenModel, ObjectId, db } from 'hydrooj';
import { isEducationAdmin, assertEducationAdmin } from '../model/education-auth';
import { userColl } from '../model/user';
import {
    Enrollment, getEnrollment, enrollmentColl, ensureEnrollmentIndexes, submitEnrollment,
    reviewEnrollment, manageEnrollment, completeEnrollmentPasswordChange,
} from '../model/enrollment';
import { decideEnrollmentAccess, enrollmentActivity, matchesContestScope } from '../model/enrollment-policy';

interface EnrollmentPretest { _id: ObjectId; uid: number; domainId: string; contestId: string; createdAt: Date }
declare module 'hydrooj' { interface Collections { oi33_enrollment_pretest: EnrollmentPretest } }
const pretestColl = db.collection('oi33_enrollment_pretest');

function domainOf(h: any): string { return h.domain?._id || h.context?.HydroContext?.domain?._id || h.args?.domainId || 'system'; }
function nameOf(h: any): string { return h.constructor.name.replace(/Handler$/, ''); }
function truthy(value: unknown) { return value === true || value === 1 || value === '1' || value === 'true'; }
function privateResponse(h: any) {
    h.response.addHeader('Cache-Control', 'private, no-store');
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
    // Core's browser gateway can authenticate a payload credential without changing h.user.
    // Pin one browser identity to a connection and retain credentials only in this closure.
    // Trusted server gateways validate their secret in core prepare() and multiplex identities.
    let gatewayIdentity: { uid: number; credential: string } | null = null;
    const trustedGateway = () => gateway && h.privileged === true;
    const checkCurrentIdentity = async () => {
        if (trustedGateway()) return;
        if (gatewayIdentity) {
            const session = await TokenModel.get(gatewayIdentity.credential, TokenModel.TYPE_SESSION);
            if (!session || session.uid !== gatewayIdentity.uid) throw new ForbiddenError('登录凭据已失效，请重新登录。');
            const user = await UserModel.getById('system', gatewayIdentity.uid);
            if (!user) throw new ForbiddenError('账号不存在。');
            const subject = Object.create(h);
            subject.user = user;
            await enforceEnrollment(subject, true);
        } else await enforceEnrollment(h, true);
    };
    const checkGatewayCredential = async (payload: any) => {
        if (!gateway || trustedGateway() || !['subscribe', 'resume'].includes(payload?.operation)) return;
        if (payload.operation === 'resume') throw new ForbiddenError('普通连接不能恢复内部网关订阅。');
        if (!payload.credential) { await checkCurrentIdentity(); return; }
        if (typeof payload.credential !== 'string' || payload.credential.length > 4096) throw new ForbiddenError('登录凭据无效。');
        const session = await TokenModel.get(payload.credential, TokenModel.TYPE_SESSION);
        if (!session?.uid) throw new ForbiddenError('登录凭据无效或已过期。');
        if ((gatewayIdentity && gatewayIdentity.uid !== session.uid) || (h.user?._id > 0 && h.user._id !== session.uid)) {
            throw new ForbiddenError('同一浏览器连接不能混用不同用户身份，请重新连接。');
        }
        const user = await UserModel.getById('system', session.uid);
        if (!user) throw new ForbiddenError('账号不存在。');
        const subject = Object.create(h);
        subject.user = user;
        await enforceEnrollment(subject, true);
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
                this.close(4003, '账号权限或登录状态已改变，请重新连接。');
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
                const result = await original?.apply(this, args);
                await checkCurrentIdentity();
                return result;
            }
            if (method === 'message') {
                try {
                    await checkGatewayCredential(args[0]);
                    await checkCurrentIdentity();
                } catch {
                    // Core's onmessage exception handler logs the whole MessageEvent, which can
                    // contain the gateway credential. Close locally without throwing that event
                    // into core logging, and never run the original method after a policy denial.
                    this.close(4003, '账号权限或登录状态已改变，请重新连接。');
                    return;
                }
            } else await checkCurrentIdentity();
            return original?.apply(this, args);
        };
    }
    // message() and prepare() can invoke onRecordChange directly, outside @subscribe.
    // Protect those paths too, including queued updates which run after the original event.
    for (const method of ['onRecordChange', 'queueClear', 'sendUpdate']) {
        const original = h[method];
        if (typeof original !== 'function') continue;
        h[method] = async function (...args: any[]) {
            await checkCurrentIdentity();
            const doc = await getEnrollment(this.user?._id);
            if (doc?.accountType === 'temporary' && method !== 'queueClear' && !(await recordAllowed(doc, this, args[0]))) return;
            return original.apply(this, args);
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
                return subscription.target.apply(this, args);
            } catch (error: any) {
                this.close(4003, '账号权限已改变，请刷新页面。');
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
            isAdmin: isEducationAdmin(this.user), active: enrollment ? enrollmentActivity(enrollment) : null };
    }

    @param('realName', Types.String)
    @param('school', Types.String, true)
    @param('studentId', Types.String, true)
    @param('requestedGroups', Types.String, true)
    @param('revision', Types.UnsignedInt)
    async post(domainId: string, realName: string, school = '', studentId = '', requestedGroups = '', revision = 0) {
        const legacy = await userColl.findOne({ _id: this.user._id });
        if (!await getEnrollment(this.user._id) && ((legacy?.realname_flag || 0) >= 1 || isEducationAdmin(this.user))) {
            throw new ForbiddenError('原有已核验身份继续有效，如需更正请联系管理员。');
        }
        try {
            await submitEnrollment(this.user._id, domainOf(this), { realName, school, studentId,
                requestedGroups: requestedGroups.split(/[,，\n]/).map((g) => g.trim()).filter(Boolean) }, revision);
        } catch (e: any) { throw new ValidationError('enrollment', e.message); }
        this.response.redirect = this.url('oi33_enrollment');
    }
}

export class Oi33EnrollmentReviewHandler extends Handler {
    async get() {
        assertEducationAdmin(this.user);
        privateResponse(this);
        const page = Math.max(1, Math.min(10000, Number.parseInt(this.args.page, 10) || 1));
        const filter: any = { domainId: domainOf(this) };
        if (['pending', 'approved', 'rejected'].includes(this.args.status)) filter.status = this.args.status;
        if (/^\d+$/.test(String(this.args.uid || ''))) filter._id = Number(this.args.uid);
        const total = await enrollmentColl.countDocuments(filter);
        const enrollments = await enrollmentColl.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * 30).limit(30).toArray();
        this.response.template = 'oi33_enrollment_review.html';
        this.response.body = { enrollments, page, pages: Math.ceil(total / 30), total,
            filterStatus: filter.status || '', filterUid: this.args.uid || '' };
    }

    @param('uid', Types.UnsignedInt)
    @param('revision', Types.UnsignedInt)
    @param('action', Types.String)
    @param('reason', Types.String, true)
    @param('validUntil', Types.String, true)
    async post(domainId: string, uid: number, revision: number, action: string, reason = '', validUntil = '') {
        assertEducationAdmin(this.user);
        const target = await getEnrollment(uid);
        if (!target || target.domainId !== domainOf(this)) throw new ForbiddenError('不能管理其他域的身份档案。');
        if (uid === this.user._id) throw new ForbiddenError('不能审核或变更自己的账号状态，请由另一位管理员操作。');
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
        this.response.redirect = this.url('oi33_enrollment_review', { query: { uid } });
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
    events.on('handler/after/HomeSecurity#post', async (h: any) => {
        if (h.args.operation === 'change_password' && h.response.redirect === h.url('user_login')) {
            await completeEnrollmentPasswordChange(h.user._id);
        }
    });
    for (const name of ['UserRegisterWithCode', 'OauthCallback', 'UserLogin']) {
        events.on(`handler/after/${name}`, async (h: any) => {
            const uid = h.context?.HydroContext?.user?._id;
            if (!uid || !h.response.redirect) return;
            const doc = await getEnrollment(uid);
            const legacy = !doc ? await userColl.findOne({ _id: uid }, { projection: { realname_flag: 1 } }) : null;
            if (doc?.requiresPasswordChange) h.response.redirect = h.url('home_security');
            else if (!doc && !(legacy?.realname_flag >= 1) && !isEducationAdmin(h.context.HydroContext.user)) h.response.redirect = h.url('oi33_enrollment');
            else if (doc && (!doc.enabled || doc.status !== 'approved' || doc.accountType === 'temporary')) h.response.redirect = h.url('oi33_enrollment');
        });
    }
}
