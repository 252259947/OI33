import {
    Context, ContestModel, ForbiddenError, Handler, NotFoundError, ObjectId, PERM, PRIV, TrainingModel,
} from 'hydrooj';
import { isEducationCoach } from '../model/education-auth';
import { getRecentLearning, LearningKind, rememberLearning } from '../model/recent-learning';
import { homeworkGroups } from './homework-access';

function currentDomain(h: any): string {
    const domainId = h.domain?._id;
    // Never accept a requested domain that may have loaded another domain's role.
    if (!domainId || (h.args?.domainId && h.args.domainId !== domainId)) {
        throw new ForbiddenError('请求域与当前域不一致。');
    }
    return domainId;
}

export async function rememberLearningVisit(h: any, kind: LearningKind) {
    const doc = h.response.body?.tdoc;
    if (h.request.method.toLowerCase() !== 'get' || h.response.redirect
        || (h.response.status && h.response.status >= 300)
        || h.response.template !== `${kind}_detail.html`
        || !h.user.hasPriv(PRIV.PRIV_USER_PROFILE) || h.user._id <= 0
        || !doc?.docId || (kind === 'homework' && doc.rule !== 'homework')) return;
    const domainId = currentDomain(h);
    if (doc.domainId && doc.domainId !== domainId) return;
    try {
        await rememberLearning(domainId, h.user._id, kind, String(doc.docId));
    } catch (error) {
        // A convenience preference must never prevent the actual lesson opening.
        console.warn('[oi33] unable to remember recent learning', error);
    }
    h.response.addHeader('Cache-Control', 'private, no-store');
}

export class RecentLearningHandler extends Handler {
    async get() {
        const domainId = currentDomain(this);
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        this.response.addHeader('Cache-Control', 'private, no-store');
        const entry = await getRecentLearning(domainId, this.user._id);
        const fallback = (reason: string) => {
            this.response.redirect = this.url('homework_main', { query: { resume: reason } });
        };
        if (!entry) { fallback('empty'); return; }
        try {
            const tid = new ObjectId(entry.tid);
            if (entry.kind === 'homework') {
                this.checkPerm(PERM.PERM_VIEW_HOMEWORK);
                const doc = await ContestModel.get(domainId, tid);
                if (doc.rule !== 'homework') { fallback('unavailable'); return; }
                const groups = await homeworkGroups(this.user, domainId);
                if (!isEducationCoach(this.user) && !doc.assign?.some((group: string) => groups.includes(group))) {
                    fallback('unavailable'); return;
                }
            } else {
                this.checkPerm(PERM.PERM_VIEW_TRAINING);
                const doc = await TrainingModel.get(domainId, tid);
                // Retain extension-defined access checks used by native details.
                await this.ctx.parallel('training/get', doc, this);
            }
            // Only server-generated native routes. The target page still runs
            // all of its normal enrollment, class and permission checks again.
            this.response.redirect = this.url(`${entry.kind}_detail`, { tid });
        } catch (error) {
            if (!(error instanceof NotFoundError) && !(error instanceof ForbiddenError)) throw error;
            fallback('unavailable');
        }
    }
}

export function addRecentLearningNotice(h: any) {
    if (h.response.template !== 'homework_main.html') return;
    const reason = h.request.query?.resume;
    if (reason === 'empty') h.response.body.oi33RecentLearningNotice = '还没有最近练习记录，请先选择一份作业；也可以从导航进入训练计划。';
    if (reason === 'unavailable') h.response.body.oi33RecentLearningNotice = '上次打开的作业或训练计划已不可访问，请重新选择一份作业或训练计划。';
}

export function apply(ctx: Context) {
    ctx.Route('oi33_recent_learning', '/oi33/learning/continue', RecentLearningHandler, PRIV.PRIV_USER_PROFILE);
    // Finish runs only after native handlers and all their after hooks succeed.
    // Unauthorized/error responses and edits cannot overwrite a good target.
    ctx.on('handler/finish/HomeworkDetail#get', (h: any) => rememberLearningVisit(h, 'homework'));
    ctx.on('handler/finish/TrainingDetail#get', (h: any) => rememberLearningVisit(h, 'training'));
    ctx.on('handler/after/HomeworkMain#get', addRecentLearningNotice);
}
