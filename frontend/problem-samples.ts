export type SampleBlock = {
    id: string;
    kind: 'input' | 'output';
    code: HTMLElement;
    native: boolean;
    scope: ParentNode;
};

type Kind = SampleBlock['kind'];
type Label = { kind?: Kind; id?: string; sample: boolean };
type Context = { id?: string; token: object };
type State = {
    context?: Context;
    pending?: Label;
    lastInput?: string;
    nextId: number;
    used: Set<string>;
    pairs: Map<string, object>;
    nativePairs: Map<string, object>;
    blockedLevel?: number;
};

function label(text: string): Label | undefined {
    const value = text.replace(/\s+/g, ' ').trim().replace(/[:：]\s*$/, '').trim();
    let match = value.match(/^(?:样例|示例|输入输出样例|samples?|examples?)(?:\s*[#＃]?\s*(\d+))?$/i);
    if (match) return { id: match[1], sample: true };
    match = value.match(/^(?:(输入|输出)(?:样例|示例)|(?:样例|示例)(输入|输出))(?:\s*[#＃]?\s*(\d+))?$/);
    if (match) return { kind: (match[1] || match[2]) === '输入' ? 'input' : 'output', id: match[3], sample: true };
    match = value.match(/^(?:(sample|example)\s+(input|output)|(input|output)\s+(sample|example))(?:\s*#?\s*(\d+))?$/i);
    if (match) return { kind: (match[2] || match[3]).toLowerCase() as Kind, id: match[5], sample: true };
    match = value.match(/^(输入|输出|input|output)(?:\s*[#＃]?\s*(\d+))?$/i);
    if (match) return { kind: /^(输入|input)$/i.test(match[1]) ? 'input' : 'output', id: match[2], sample: false };
    return undefined;
}

const newState = (): State => ({ nextId: 1, used: new Set(), pairs: new Map(), nativePairs: new Map() });
const classes = (node: HTMLElement) => (typeof node.className === 'string' ? node.className : '').split(/\s+/);
const isElement = (node: Node): node is HTMLElement => node.nodeType === 1;
const children = (node: ParentNode) => Array.from(node.childNodes).filter(isElement);
const inline = new Set(['A', 'B', 'STRONG', 'EM', 'I', 'SPAN', 'SMALL', 'BR', 'SUB', 'SUP']);

/** Read public sample structure only; never retag code or rerun Prism. */
export function discoverSampleBlocks(root: ParentNode): SampleBlock[] {
    const candidates: { block: SampleBlock; token: object }[] = [];
    const clear = (state: State) => {
        state.context = undefined;
        state.pending = undefined;
        state.lastInput = undefined;
        state.pairs.clear();
    };
    const nextId = (state: State) => {
        while (state.used.has(String(state.nextId))) state.nextId += 1;
        return String(state.nextId++);
    };
    const acceptLabel = (state: State, text: string, level = 0) => {
        if (level && state.blockedLevel && level <= state.blockedLevel) state.blockedLevel = undefined;
        if (state.blockedLevel) { clear(state); return; }
        if (level && /^(?:(?:样例|示例)?(?:说明|解释)|提示|题解|注释|输入格式|输出格式)|^(?:sample\s+)?(?:explanation|notes?|hints?|solution|input format|output format)\b/i.test(text.trim())) {
            clear(state);
            state.blockedLevel = level;
            return;
        }
        const parsed = label(text);
        if (!parsed || (!parsed.sample && !state.context)) {
            clear(state);
            return;
        }
        if (!parsed.kind) {
            state.context = { id: parsed.id, token: {} };
            state.pending = undefined;
            state.lastInput = undefined;
        } else {
            // A qualified input/output heading is sufficient sample context.
            if (parsed.sample && (!state.context || (parsed.id && state.context.id !== parsed.id))) {
                state.context = { id: parsed.id, token: {} };
            }
            state.pending = parsed;
        }
    };
    const visit = (node: ParentNode, scope: ParentNode, state: State, infer = true) => {
        for (const child of Array.from(node.childNodes)) {
            if (!isElement(child)) {
                if (child.nodeType === 3 && child.textContent?.trim()) acceptLabel(state, child.textContent);
                continue;
            }
            const tag = child.tagName.toUpperCase();
            const classNames = classes(child);
            if (classNames.includes('richmedia') && child !== scope) {
                clear(state);
                visit(child, child, newState(), infer);
                continue;
            }
            if (classNames.includes('toolbar') || ['SCRIPT', 'STYLE', 'CODE', 'SVG', 'MATH'].includes(tag)) continue;
            if (tag === 'PRE') {
                const code = children(child).find((item) => item.tagName.toUpperCase() === 'CODE');
                if (!code) { state.pending = undefined; continue; }
                const native = code.className.match(/(?:^|\s)language-(input|output)(\d*)(?=\s|$)/);
                const pending = state.pending;
                state.pending = undefined;
                const plain = !/\blanguage-(?!text(?:\s|$)|plain(?:text)?(?:\s|$)|none(?:\s|$))\S+/.test(code.className);
                if (!native && (!infer || !plain || !pending?.kind || !state.context)) continue;
                const kind = (native?.[1] || pending!.kind) as Kind;
                const id = native ? (native[2] || '1') : pending!.id || state.context?.id
                    || (kind === 'output' ? state.lastInput : undefined) || nextId(state);
                state.used.add(id);
                let token: object;
                if (native) {
                    token = state.nativePairs.get(id) || state.context?.token || {};
                    if (kind === 'input' && candidates.some((item) => item.block.scope === scope
                        && item.block.id === id && item.block.kind === 'input' && item.token === token)) token = {};
                    state.nativePairs.set(id, token);
                    if (state.context?.id === id) state.context.token = token;
                } else if (state.context?.id === id) {
                    token = state.context.token;
                    if (kind === 'input' && candidates.some((item) => item.block.scope === scope
                        && item.block.id === id && item.block.kind === 'input' && item.token === token)) {
                        token = {};
                        state.context.token = token;
                    }
                } else token = kind === 'output' ? state.pairs.get(id) || {} : {};
                if (kind === 'input') {
                    state.lastInput = id;
                    state.pairs.set(id, token);
                }
                candidates.push({ block: { id, kind, code, native: !!native, scope }, token });
                continue;
            }
            if (/^H[1-6]$/.test(tag)) {
                acceptLabel(state, child.textContent || '', Number(tag[1]));
                continue;
            }
            const nested = children(child);
            if (['P', 'DIV', 'STRONG', 'B', 'LABEL', 'SPAN'].includes(tag)
                && nested.every((item) => inline.has(item.tagName.toUpperCase()))) {
                acceptLabel(state, child.textContent || '');
                continue;
            }
            // Code examples in quotes/tables/lists are not inferred as samples;
            // explicit language-input/output markup remains authoritative.
            if (['BLOCKQUOTE', 'TABLE', 'UL', 'OL'].includes(tag)) {
                const isolated = newState();
                visit(child, scope, isolated, false);
                state.pending = undefined;
            } else visit(child, scope, state, infer);
        }
    };
    visit(root, root, newState());

    // A repeated id must not combine the first input with a later group's output.
    // Keep its first input and only that pair's output, or the first standalone output.
    return candidates.filter((item) => {
        const peers = candidates.filter((other) => other.block.scope === item.block.scope && other.block.id === item.block.id);
        const firstInput = peers.find((other) => other.block.kind === 'input');
        if (item.block.kind === 'input') return item === firstInput;
        const output = peers.find((other) => other.block.kind === 'output' && (!firstInput || other.token === firstInput.token));
        return item === output;
    }).map((item) => item.block);
}
