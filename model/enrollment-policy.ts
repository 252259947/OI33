export type EnrollmentStatus = 'pending' | 'approved' | 'rejected';
export type EnrollmentAccountType = 'regular' | 'temporary';
export interface ContestScope { domainId: string; contestId: string }
export interface EnrollmentAccess {
    status: EnrollmentStatus;
    accountType: EnrollmentAccountType;
    enabled: boolean;
    validFrom?: Date | string;
    validUntil?: Date | string;
    contestScopes: ContestScope[];
    requiresPasswordChange?: boolean;
}
export interface EnrollmentRequestContext {
    uid: number;
    domainId: string;
    handler: string;
    method: string;
    operation?: string;
    category?: string;
    contestId?: string;
    recordInScope?: boolean;
    isAdmin?: boolean;
    hasJudgePrivilege?: boolean;
    legacyVerified?: boolean;
    now?: number;
}
export type EnrollmentDecision = { allowed: boolean; reason?: string };

export function enrollmentActivity(doc: EnrollmentAccess, now = Date.now()): EnrollmentDecision {
    if (!doc.enabled) return { allowed: false, reason: '账号已停用，请联系教练。' };
    if (doc.status !== 'approved') return { allowed: false, reason: '请先完成实名申请并等待审核。' };
    const from = doc.validFrom === undefined ? undefined : new Date(doc.validFrom).getTime();
    const until = doc.validUntil === undefined ? undefined : new Date(doc.validUntil).getTime();
    if ((from !== undefined && !Number.isFinite(from)) || (until !== undefined && !Number.isFinite(until))) {
        return { allowed: false, reason: '账号有效期配置异常，请联系教练。' };
    }
    if (from !== undefined && now < from) return { allowed: false, reason: '账号尚未到启用时间。' };
    if (until !== undefined && now >= until) return { allowed: false, reason: '临时账号已到期，历史成绩和提交记录已保留。' };
    if (doc.accountType === 'temporary' && (until === undefined || !doc.contestScopes?.length)) {
        return { allowed: false, reason: '临时账号缺少有效期或比赛范围，请联系教练。' };
    }
    return { allowed: true };
}

export function matchesContestScope(doc: EnrollmentAccess, domainId: string, contestId?: string): boolean {
    return !!contestId && /^[a-f\d]{24}$/i.test(contestId)
        && doc.contestScopes?.some((scope) => scope.domainId === domainId
            && scope.contestId.toLowerCase() === contestId.toLowerCase());
}

function isAccountMaintenance(c: EnrollmentRequestContext): boolean {
    if (['UserLogin', 'UserLogout', 'UserLostPass', 'UserLostPassWithCode', 'UserSudo', 'UserTFA',
        'UserWebauthn', 'HomeSecurity', 'UserChangemailWithCode', 'Oi33Enrollment'].includes(c.handler)) return true;
    return c.handler === 'HomeSettings' && ['preference', 'code'].includes(c.category || '');
}

// Deny by default for a temporary account: adding a new route cannot expand its scope.
// This is an additional gate; it never replaces Hydro's own permission/contest checks.
export function decideEnrollmentAccess(doc: EnrollmentAccess | null, c: EnrollmentRequestContext): EnrollmentDecision {
    const read = ['get', 'head'].includes(c.method.toLowerCase());
    const socket = c.method.toLowerCase() === 'ws';
    if (c.uid <= 0) return { allowed: true }; // Hydro continues to enforce anonymous privileges.
    if (isAccountMaintenance(c)) return { allowed: true };
    if (!doc) {
        // Hydro judge workers are provisioned infrastructure principals, not public registrants.
        // Exempt only their existing PRIV_JUDGE-protected endpoints. An enrollment document
        // always takes precedence, so a temporary/disabled person cannot borrow this exemption.
        if (c.hasJudgePrivilege && ['JudgeConnection', 'JudgeFilesDownload', 'JudgeFileUpdate'].includes(c.handler)) {
            return { allowed: true };
        }
        if (c.isAdmin || c.legacyVerified || read) return { allowed: true };
        return { allowed: false, reason: '请先前往「实名与账号」提交实名申请，审核通过后即可使用。' };
    }
    if (doc.requiresPasswordChange) return { allowed: false, reason: '请先在账号安全设置中修改初始密码。' };
    const active = enrollmentActivity(doc, c.now);
    if (!active.allowed) {
        // Unverified regular users may read public content, but cannot mutate it.
        if (doc.enabled && doc.accountType === 'regular' && doc.status !== 'approved' && read) return { allowed: true };
        return active;
    }
    if (doc.accountType === 'regular') return { allowed: true };
    const inContest = matchesContestScope(doc, c.domainId, c.contestId);
    const readHandlers = ['ContestDetail', 'ContestProblemList', 'ContestScoreboard', 'ContestFileDownload',
        'ProblemDetail', 'ProblemSubmit', 'ProblemFileDownload'];
    if (inContest && read && readHandlers.includes(c.handler)) return { allowed: true };
    if (inContest && c.method.toLowerCase() === 'post') {
        if (c.handler === 'ProblemSubmit' && !c.operation) return { allowed: true };
        if (c.handler === 'ContestDetail' && ['attend', 'subscribe', 'early_end'].includes(c.operation || '')) return { allowed: true };
        if (c.handler === 'ContestProblemList' && c.operation === 'clarification') return { allowed: true };
    }
    if ((read || socket) && c.recordInScope && ['RecordList', 'RecordDetail', 'RecordMainConnection', 'RecordDetailConnection'].includes(c.handler)) {
        return { allowed: true };
    }
    return { allowed: false, reason: '此临时账号仅可使用指定比赛及其题目，其他功能暂不开放。' };
}

export function requireEnrollmentRevision(actual: number, expected: number): void {
    if (!Number.isSafeInteger(expected) || expected < 0 || actual !== expected) {
        throw new Error('资料已更新，请刷新页面后重新操作。');
    }
}
