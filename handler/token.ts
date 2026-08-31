import {
    Handler, PRIV, Types, param, Context,
} from 'hydrooj';
import { oi33Model } from '../model';

class TokenListHandler extends Handler {
    async get() {
        if (this.user.hasPriv(PRIV.PRIV_ALL)) {
            const tokens = await oi33Model.getAllActiveTokens();
            this.response.template = 'oi33_tokens.html';
            this.response.body = { tokens, isAdmin: true };
        } else {
            const tokens = await oi33Model.getTokensByUid(this.user._id);
            this.response.template = 'oi33_tokens.html';
            this.response.body = { tokens, isAdmin: false };
        }
    }
}

class TokenCreateHandler extends Handler {
    @param('name', Types.String)
    @param('expires', Types.String, true)
    @param('uid', Types.Int, true)
    async post(_domainId: string, name: string, expires = '', uid?: number) {
        this.checkPriv(PRIV.PRIV_ALL);
        const targetUid = uid || this.user._id;
        const domainList = ['system'];
        const expiresAt = expires ? new Date(expires) : undefined;
        const { _id, rawToken } = await oi33Model.createToken(targetUid, name, domainList, expiresAt);
        this.response.template = 'oi33_tokens.html';
        this.response.body = {
            tokens: await oi33Model.getAllActiveTokens(),
            newToken: rawToken,
            newTokenId: _id,
            isAdmin: true,
        };
    }
}

class TokenDeleteHandler extends Handler {
    @param('id', Types.String)
    async post(domainId: string, id: string) {
        this.checkPriv(PRIV.PRIV_ALL);
        await oi33Model.deleteToken(id);
        this.response.redirect = '/oi33/tokens';
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_tokens', '/oi33/tokens', TokenListHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_token_create', '/oi33/tokens/create', TokenCreateHandler, PRIV.PRIV_ALL);
    ctx.Route('oi33_token_delete', '/oi33/tokens/:id/delete', TokenDeleteHandler, PRIV.PRIV_ALL);
}
