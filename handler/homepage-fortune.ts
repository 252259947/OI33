import { Context, moment } from 'hydrooj';
import { getCheckinUser } from '../model/user';

const DEFAULT_FORTUNES = [
    { text: '大吉', color: '#ED5A65' },
    { text: '吉', color: '#ED5A65' },
    { text: '小吉', color: '#ED5A65' },
    { text: '平', color: 'var(--oi33-text, #64748b)' },
    { text: '小凶', color: 'var(--oi33-text, #64748b)' },
    { text: '凶', color: 'var(--oi33-text, #64748b)' },
    { text: '大凶', color: 'var(--oi33-text, #64748b)' },
];

export async function getHomepageFortune(uid: number, config: unknown) {
    // Hydro accepts `checkin: true`. Never attach viewer data to that primitive
    // or to the shared settings object; create a fresh payload for each request.
    const settings = config && typeof config === 'object' && !Array.isArray(config) ? config as any : {};
    const payload: any = {
        ...settings,
        luck_today: moment().format('YYYY-MM-DD'),
        luck_type: DEFAULT_FORTUNES.map((fallback, index) => ({
            text: typeof settings.luck_type?.[index]?.text === 'string' ? settings.luck_type[index].text : fallback.text,
            color: typeof settings.luck_type?.[index]?.color === 'string' ? settings.luck_type[index].color : fallback.color,
        })),
        luck_vip: Array.isArray(settings.luck_vip) ? [...settings.luck_vip] : [],
        oi33_checkin_flag: 0,
        oi33_checkin: null,
    };
    if (uid > 0) {
        const user = await getCheckinUser(uid);
        payload.oi33_checkin_flag = user?.realname_flag ?? 0;
        if (user?.checkin_time) payload.oi33_checkin = {
            time: user.checkin_time,
            luck: Math.min(6, Math.max(0, Math.floor(Number(user.checkin_luck) || 0))),
            cnt_now: user.checkin_cnt_now ?? 0,
            cnt_all: user.checkin_cnt_all ?? 0,
        };
    }
    return payload;
}

export function apply(ctx: Context) {
    ctx.on('handler/create', (h: any) => {
        if (h.constructor.name !== 'HomeHandler') return;
        h.getCheckin = function (_domainId: string, config: unknown) {
            this.response.addHeader('Cache-Control', 'private, no-store');
            return getHomepageFortune(this.user?._id || 0, config);
        };
    });
}
