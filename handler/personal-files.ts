import { Context, ForbiddenError, PRIV } from 'hydrooj';
import { isEducationCoach } from '../model/education-auth';

/** Personal storage is reserved for teaching staff, without granting native upload privileges. */
export function canUploadPersonalFiles(h: any): boolean {
    const domainId = h.domain?._id || h.context?.HydroContext?.domain?._id;
    // Core can load a domain role from request parameters. Do not accept a coach
    // role borrowed from another domain through /file?domainId=... .
    if (h.args?.domainId && String(h.args.domainId) !== domainId) return false;
    return isEducationCoach(h.user) && !!h.user.hasPriv?.(PRIV.PRIV_CREATE_FILE);
}

export function apply(ctx: Context) {
    ctx.on('handler/before-prepare/Files', (h: any) => {
        const upload = h.postUploadFile;
        // Wrap only this request's personal-file operation. Core validation,
        // quotas and storage stay intact; delete/download and problem files do not change.
        h.postUploadFile = function (...args: any[]) {
            if (!canUploadPersonalFiles(this)) throw new ForbiddenError('没有权限');
            return upload.apply(this, args);
        };
    });
    ctx.on('handler/after/Files#get', (h: any) => {
        h.response.body.oi33CanUploadPersonalFiles = canUploadPersonalFiles(h);
        h.response.addHeader('Cache-Control', 'private, no-store');
    });
}
