import type { Context } from 'hydrooj';

type HomeSection = [string, unknown];
type HomeColumn = { width: number; sections: HomeSection[]; [key: string]: unknown };

/** Only adjust this response; preserve the administrator's homepage setting. */
export function withHomeworkSection(contents: HomeColumn[], payload: unknown): HomeColumn[] {
    const columns = contents.map((column) => ({
        ...column,
        sections: column.sections.filter(([name]) => name !== 'homework'),
    }));
    if (!columns.length) columns.push({ width: 12, sections: [] });
    const target = columns.find((column) => column.sections.some(([name]) => name === 'contest'))
        || columns.find((column) => column.sections.some(([name]) => name === 'training'))
        || columns[0];
    const contestIndex = target.sections.findIndex(([name]) => name === 'contest');
    const trainingIndex = target.sections.findIndex(([name]) => name === 'training');
    const index = contestIndex >= 0 ? contestIndex + 1 : trainingIndex >= 0 ? trainingIndex : 0;
    target.sections.splice(index, 0, ['homework', payload]);
    return columns;
}

export async function addHomepageHomework(handler: any) {
    const body = handler.response?.body;
    if (handler.response?.template !== 'main.html' || !Array.isArray(body?.contents)) return;
    if (typeof handler.getHomework !== 'function') return;
    // A configured section has already run Hydro's permission-filtered query.
    // Reuse it rather than requesting the same data twice.
    const existing = body.contents.flatMap((column: HomeColumn) => column.sections)
        .find(([name]: HomeSection) => name === 'homework');
    const payload = existing ? existing[1] : await handler.getHomework(handler.args.domainId)
        .catch(() => [[], {}, { unavailable: true }]);
    body.contents = withHomeworkSection(body.contents, payload);
}

export function apply(ctx: Context) {
    ctx.on('handler/after/Home#get', addHomepageHomework);
}
