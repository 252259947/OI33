import { AsyncLocalStorage } from 'node:async_hooks';
import { Context } from 'hydrooj';
import { getScoreboardRealNames } from '../model/scoreboard-identity';

const csvExport = new AsyncLocalStorage<boolean>();
const wrappedRequests = new WeakSet<object>();

export function wrapScoreboardRequest(h: any) {
    if (wrappedRequests.has(h) || typeof h.get !== 'function') return;
    wrappedRequests.add(h);
    const original = h.get;
    // Scope the context to this request, not a globally registered view. This
    // also survives the native scoreboard service being reloaded/re-registered.
    h.get = function (...args: any[]) {
        return csvExport.run(this.args?.view === 'csv', () => original.apply(this, args));
    };
}

export async function applyScoreboardNames(tdoc: any, rows: any[][], udict: Record<number, any>) {
    if (!tdoc?.domainId || !Array.isArray(rows) || !udict) return;
    const cells = rows.slice(1).flat().filter((cell) => cell?.type === 'user' && udict[cell.raw]);
    const names = await getScoreboardRealNames(tdoc.domainId, cells.map((cell) => Number(cell.raw)));
    for (const cell of cells) {
        const name = names[Number(cell.raw)];
        if (!name) continue;
        cell.oi33RealName = name;
        // CSV quoting alone does not stop spreadsheet formula execution.
        cell.value = csvExport.getStore() && /^[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/.test(name) ? `'${name}` : name;
    }
}

export async function applyTrainingNames(h: any) {
    const body = h.response?.body;
    if (!body?.tdoc?.domainId || !body.udict || body.tdoc.domainId !== h.domain?._id) return;
    body.oi33TrainingNames = await getScoreboardRealNames(body.tdoc.domainId,
        Object.keys(body.udict).map(Number));
    h.response.addHeader('Cache-Control', 'private, no-store');
}

export function apply(ctx: Context) {
    // Native permission, assignment and frozen-scoreboard checks run before
    // getScoreboard emits this event. Change user labels only, not scores/IDs.
    ctx.on('contest/scoreboard', applyScoreboardNames);
    ctx.on('handler/before/ContestScoreboard#get', wrapScoreboardRequest);
    ctx.on('handler/after/TrainingDetail#get', applyTrainingNames);
    ctx.on('handler/after/ContestScoreboard#get', (h: any) => {
        h.response.addHeader('Cache-Control', 'private, no-store');
    });
}
