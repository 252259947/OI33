import { PRIV } from 'hydrooj';

// Same site-admin boundary as account management. Domain owners/coaches alone
// do not qualify. Accept raw user projections as well as Hydro User instances.
export function isBioModerationExempt(user: any, oi33?: { realname_flag?: number }): boolean {
    if (!Number.isSafeInteger(user?._id) || user._id <= 0) return false;
    const flag = oi33 ? oi33.realname_flag : user.realname_flag;
    return Number(flag || 0) >= 2 || !!user.hasPriv?.(PRIV.PRIV_ALL)
        || (Number.isSafeInteger(user.priv) && (user.priv & PRIV.PRIV_ALL) === PRIV.PRIV_ALL);
}
