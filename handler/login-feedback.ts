const messages: Record<string, string> = {
    LoginError: '用户名或密码不正确，请检查后重试。也可以使用注册邮箱登录。',
    UserNotFoundError: '用户名或密码不正确，请检查后重试。也可以使用注册邮箱登录。',
    InvalidTokenError: '验证信息不正确或已过期，请重新验证后登录。',
};

/** Keep native authentication, MFA and rate limiting. Only the failed HTML
 * response is rendered as the login form; API clients retain native errors. */
export function installLoginFeedback(h: any) {
    if (h.constructor.name !== 'UserLoginHandler' || h.__oi33LoginFeedback
        || typeof h.onerror !== 'function') return;
    h.__oi33LoginFeedback = true;
    const original = h.onerror;
    h.onerror = async function (error: any) {
        await original.call(this, error);
        if (this.request.method?.toLowerCase() !== 'post' || this.request.json
            || !(this.request.headers?.accept || '').includes('text/html')
            || this.request.headers?.['x-requested-with'] || this.response.redirect) return;
        let message = messages[error?.name];
        if (error?.name === 'ValidationError' && ['uname', 'password'].includes(error.params?.[0])) {
            message = '请填写有效的用户名或注册邮箱，并输入密码。';
        }
        if (!message) return;
        this.response.addHeader('Cache-Control', 'private, no-store');
        this.response.template = 'user_login.html';
        this.response.body = {
            loginError: message,
            loginUsername: typeof this.args.uname === 'string' ? this.args.uname.slice(0, 254) : '',
            loginRemember: [true, 'true', 'on', '1'].includes(this.args.rememberme),
            redirect: typeof this.args.redirect === 'string' ? this.args.redirect : '',
            loginMethods: this.loginMethods,
        };
    };
}

export function applyLoginFeedback(ctx: any) {
    ctx.on('handler/create/http', installLoginFeedback);
}
