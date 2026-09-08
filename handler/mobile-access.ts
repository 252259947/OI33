import { Context, ForbiddenError } from 'hydrooj';

type Headers = Record<string, string | string[] | undefined>;
const MESSAGE = '请使用电脑访问 huaji OJ。';

function header(headers: Headers, name: string): string {
    const key = Object.keys(headers || {}).find((value) => value.toLowerCase() === name);
    const value = key ? headers[key] : '';
    return Array.isArray(value) ? value.join(', ') : value || '';
}

// This is a browser access policy, not hardware attestation. Do not infer a
// phone from viewport width, touch support, or an ordinary desktop/macOS UA.
export function isPhoneBrowser(headers: Headers = {}): boolean {
    const ua = header(headers, 'user-agent');
    if (/\b(?:iPad|Tablet|Kindle|Silk)\b/i.test(ua)) return false;
    if (header(headers, 'sec-ch-ua-mobile').trim() === '?1') return true;
    return /\b(?:iPhone|iPod|Windows Phone|IEMobile|BlackBerry|BB10|webOS|Opera Mini|Opera Mobi|Mobile)\b/i.test(ua);
}

// Self-contained so a rejected phone never loads the normal application shell
// or its scripts. There is no resize detector and no desktop-mode bypass link.
const blockedPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>请使用电脑访问 - huaji OJ</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f4f5fa;color:#192236;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
main{width:100%;max-width:420px;padding:36px 26px;background:#fff;border:1px solid #e2e5f0;border-radius:20px;box-shadow:0 12px 36px #2633650a;text-align:center}
.logo{display:inline-grid;place-items:center;width:48px;height:48px;border-radius:14px;background:#6058ea;color:white;font-size:20px;font-weight:800}h1{margin:24px 0 14px;font-size:25px;line-height:1.4}p{margin:0;color:#637087;line-height:1.8;font-size:15px}
</style></head><body><main><div class="logo" aria-hidden="true">HJ</div><h1>请使用电脑访问</h1>
<p>huaji OJ 暂不支持手机访问。<br>请在电脑浏览器中打开本站。</p></main></body></html>`;

export async function enforceMobileAccess(c: any, next: () => Promise<unknown>) {
    try {
        const headers = c.request.headers || {};
        if (!isPhoneBrowser(headers)) return await next();
        c.set('Cache-Control', 'private, no-store');
        c.set('Pragma', 'no-cache');
        c.set('X-Robots-Tag', 'noindex, nofollow');
        const wantsJson = /application\/(?:[a-z.+-]*\+)?json/i.test(`${header(headers, 'accept')} ${header(headers, 'content-type')}`)
            || header(headers, 'x-requested-with').toLowerCase() === 'xmlhttprequest'
            || /^(?:\/d\/[^/]+)?\/api(?:\/|$)/.test(c.path || c.request.path || '');
        c.type = wantsJson ? 'application/json' : 'text/html; charset=utf-8';
        c.body = wantsJson ? { error: { name: 'MobileAccessDenied', code: 'PHONE_BROWSER_UNSUPPORTED', message: MESSAGE } } : blockedPage;
        c.status = 403;
        // Deliberately do not call next(): GET, POST and APIs stop before routes.
        return undefined;
    } finally {
        // Both allowed and denied responses vary by device headers so a shared
        // cache cannot hand a desktop page to a phone (or a denial to a desktop).
        c.vary('User-Agent');
        c.vary('Sec-CH-UA-Mobile');
    }
}

export function apply(ctx: Context) {
    ctx.inject(['server'], (child) => {
        // Hydro executes server layers before router/handler layers. Existing
        // static-file layers may answer earlier; no filename-suffix exemption.
        child.server.addServerLayer('oi33-mobile-access', enforceMobileAccess);
        child.on('handler/create/ws', (handler: any) => {
            if (isPhoneBrowser(handler.request?.headers || {})) throw new ForbiddenError(MESSAGE);
        });
    });
}
