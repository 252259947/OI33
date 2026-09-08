import { ForbiddenError, PRIV } from 'hydrooj';

/** Teaching roles never come from a student's class membership or application. */
export function isEducationAdmin(user: any): boolean {
    if (!user?._id) return false;
    return !!user.hasPriv?.(PRIV.PRIV_ALL) || user.role === 'root'
        || Number(user.realname_flag || 0) >= 2;
}

export function isEducationCoach(user: any): boolean {
    return isEducationAdmin(user) || (!!user?._id && user.role === 'coach');
}

export function assertEducationAdmin(user: any): void {
    if (!isEducationAdmin(user)) throw new ForbiddenError('仅管理员可以进行此操作。');
}

export function assertEducationCoach(user: any): void {
    if (!isEducationCoach(user)) throw new ForbiddenError('仅教练可以管理班型和作业。');
}
