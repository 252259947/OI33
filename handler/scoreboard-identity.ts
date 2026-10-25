import { AsyncLocalStorage } from 'node:async_hooks';
import { Context, PERM } from 'hydrooj';
import avatar from 'hydrooj/src/lib/avatar';
import { isEducationCoach } from '../model/education-auth';
import { getScoreboardRealNames } from '../model/scoreboard-identity';

const csvExport = new AsyncLocalStorage<boolean>();
const wrappedRequests = new WeakSet<object>();

export function wrapScoreboardRequest(h: any) {
    if (wrappedRequests.has(h) || typeof h.get !== 'function') return;
    wrappedRequests.add(h);
    const original = h.get;
    // Scope the context to this request, not a globally registered view. This
    // also survives the native scoreboard service being reloaded/re-registered.
    h.get = function (...args: any[]) {
        return csvExport.run(this.args?.view === 'csv', async () => {
            const user = this.user;
            const studentExport = ['html', 'csv'].includes(this.args?.view) && user && !isEducationCoach(user);
            if (studentExport) {
                // Native exports use this bit to append email/school/name/ID
                // columns. Restrict only this request; keep its other gates.
                this.user = Object.create(user, {
                    hasPerm: { value: (...permissions: bigint[]) => permissions.some((permission) => (
                        !(permission & PERM.PERM_VIEW_USER_PRIVATE_INFO) && user.hasPerm(permission)
                    )) },
                });
            }
            try {
                return await original.apply(this, args);
            } finally {
                if (studentExport) this.user = user;
            }
        });
    };
}

export function sanitizeStudentScoreboardUsers(h: any) {
    const body = h.response?.body;
    if (!h.user?._id || isEducationCoach(h.user) || !body?.tdoc
        || body.tdoc.domainId !== h.domain?._id) return;
    const present = (original: any) => {
        if (!original || !Number.isSafeInteger(original._id)) return original;
        const user = Object.create(Object.getPrototypeOf(original), Object.getOwnPropertyDescriptors(original));
        // Verified names remain in the dedicated scoreboard cells/member map.
        // User objects also reach JSON, so hide unrelated private profile data.
        user.mail = '';
        user.school = '';
        user.studentId = '';
        user.displayName = '';
        user.realname_name = '';
        if (typeof user.avatar === 'string' && user.avatar.startsWith('gravatar:')) {
            user.avatar = `url:${avatar(user.avatar, 128)}`;
        }
        return user;
    };
    if (body.udict) body.udict = Object.fromEntries(Object.entries(body.udict).map(([uid, user]) => [uid, present(user)]));
    if (body.udoc) body.udoc = present(body.udoc);
}

export async function applyScoreboardNames(tdoc: any, rows: any[][], udict: Record<number, any>) {
    if (!tdoc?.domainId || !Array.isArray(rows) || !udict) return;
    const cells = rows.slice(1).flat().filter((cell) => cell?.type === 'user' && udict[cell.raw]);
    const names = await getScoreboardRealNames(tdoc.domainId, cells.map((cell) => Number(cell.raw)));
    for (const cell of cells) {
        const name = names[Number(cell.raw)];
        if (!name) continue;
        cell.oi33RealName = name;
        // CSV quoting alone does not stop spreadsheet formula execution.
        cell.value = csvExport.getStore() && /^[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/.test(name) ? `'${name}` : name;
    }
}

export async function applyTrainingNames(h: any) {
    const body = h.response?.body;
    if (!body?.tdoc?.domainId || !body.udict || body.tdoc.domainId !== h.domain?._id) return;
    body.oi33TrainingNames = await getScoreboardRealNames(body.tdoc.domainId,
        Object.keys(body.udict).map(Number));
    sanitizeStudentScoreboardUsers(h);
    h.response.addHeader('Cache-Control', 'private, no-store');
}

export function apply(ctx: Context) {
    // Native permission, assignment and frozen-scoreboard checks run before
    // getScoreboard emits this event. Change user labels only, not scores/IDs.
    ctx.on('contest/scoreboard', applyScoreboardNames);
    ctx.on('handler/before/ContestScoreboard#get', wrapScoreboardRequest);
    ctx.on('handler/after/TrainingDetail#get', applyTrainingNames);
    ctx.on('handler/after/ContestScoreboard#get', (h: any) => {
        sanitizeStudentScoreboardUsers(h);
        h.response.addHeader('Cache-Control', 'private, no-store');
    });
}
