import { Context, ForbiddenError, PERM } from 'hydrooj';
import { isEducationCoach } from '../model/education-auth';

function matchingDomain(h: any): boolean {
    const domainId = h.domain?._id || h.context?.HydroContext?.domain?._id;
    return !!domainId && (!h.args?.domainId || String(h.args.domainId) === domainId);
}

export function canCreateTraining(h: any): boolean {
    return matchingDomain(h) && isEducationCoach(h.user) && !!h.user.hasPerm?.(PERM.PERM_CREATE_TRAINING);
}

export function enforceTrainingCreation(h: any): void {
    // Hydro can load a role using a domainId supplied in the query/body.
    // Reject borrowed roles before running the original permission checks.
    if (!matchingDomain(h)) throw new ForbiddenError('请求域与当前域不一致。');
    // Only router params identify an existing training. A query/body tid on
    // /training/create must not turn a student's request into an edit bypass.
    if ((!h.context?.params?.tid || !h.args?.tid) && !canCreateTraining(h)) {
        throw new ForbiddenError('当前账号没有新建训练的权限，仅教练和管理员可创建。');
    }
}

export function apply(ctx: Context) {
    ctx.on('handler/before-prepare/TrainingEdit', enforceTrainingCreation);
    ctx.on('handler/before/TrainingEdit#post', enforceTrainingCreation);
    ctx.on('handler/after/TrainingMain#get', (h: any) => {
        h.response.body.oi33CanCreateTraining = canCreateTraining(h);
        h.response.addHeader('Cache-Control', 'private, no-store');
    });
}
