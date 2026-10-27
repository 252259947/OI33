import { Context, PERM, PRIV, ProblemModel, STATUS, TrainingModel, ValidationError } from 'hydrooj';
import { calculateTrainingProgress, validateTrainingDependencies } from '../frontend/training-progress';

export function validateTrainingSubmission(h: any) {
    try {
        const dag = JSON.parse(h.args?.dag);
        if (!Array.isArray(dag)) throw new Error('训练计划必须是章节数组。');
        validateTrainingDependencies(dag);
    } catch (error) {
        throw new ValidationError('dag', null, error instanceof Error ? error.message : '先修关系格式无效。');
    }
}

export async function refreshTrainingDetail(h: any) {
    const body = h.response?.body;
    if (!body?.tdoc?.dag || !body.psdict || body.tdoc.domainId !== h.domain?._id) return;
    const result = calculateTrainingProgress(body.tdoc.dag, body.psdict, STATUS.STATUS_ACCEPTED);
    body.ndict = result.ndict;
    body.nsdict = result.nsdict;
    body.tsdoc = { ...body.tsdoc, ...result.summary };
    // Native details already save the viewed status. Repair this user's cache,
    // but do not add writes to another student's account from a comparison view.
    if (body.tsdoc.uid === h.user._id && h.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
        await TrainingModel.setStatus(body.tdoc.domainId, body.tdoc.docId, h.user._id, result.summary);
    }
    h.response.addHeader('Cache-Control', 'private, no-store');
}

/** Batch only documents already admitted to this response by the native handler. */
export async function refreshTrainingSummaries(h: any, tdocs: any[], tsdict: Record<string, any>) {
    const domainId = h.domain?._id;
    if (!domainId || !h.user.hasPriv(PRIV.PRIV_USER_PROFILE) || !Array.isArray(tdocs) || !tsdict) return;
    const visible = tdocs.filter((doc) => doc.domainId === domainId && Array.isArray(doc.dag) && tsdict[String(doc.docId)]);
    if (!visible.length) return;
    const pids = [...new Set(visible.flatMap((doc) => doc.dag.flatMap((node: any) => node.pids.map(Number))))] as number[];
    // Match the native detail visibility policy, including hidden problems owned
    // by this viewer. Missing/hidden problems must not become accepted by cache.
    const pdict = await ProblemModel.getList(domainId, pids,
        h.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || h.user._id, false, ['docId', 'owner', 'maintainer', 'hidden'], true);
    const exist = pids.filter((pid) => pdict[pid]?.docId);
    // Problem status is updated only by formal judging; pretest records do not
    // enter this model. One query covers all visible plans, independent of count.
    const statuses = await ProblemModel.getListStatus(domainId, h.user._id, exist);
    for (const doc of visible) {
        const key = String(doc.docId);
        tsdict[key] = { ...tsdict[key], ...calculateTrainingProgress(doc.dag, statuses, STATUS.STATUS_ACCEPTED).summary };
    }
    h.response.addHeader('Cache-Control', 'private, no-store');
}

export function apply(ctx: Context) {
    ctx.on('handler/before/TrainingEdit#post', validateTrainingSubmission);
    ctx.on('handler/after/TrainingDetail#get', refreshTrainingDetail);
    ctx.on('handler/after/TrainingMain#get', async (h: any) => {
        const body = h.response?.body;
        await refreshTrainingSummaries(h, body?.tdocs, body?.tsdict);
    });
    ctx.on('handler/after/Home#get', async (h: any) => {
        if (!Array.isArray(h.response?.body?.contents)) return;
        for (const column of h.response.body.contents) {
            for (const [name, payload] of column.sections || []) {
                if (name === 'training' && Array.isArray(payload)) await refreshTrainingSummaries(h, payload[0], payload[1]);
            }
        }
    });
}
