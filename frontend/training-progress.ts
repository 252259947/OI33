export interface TrainingProgressNode {
    _id: number;
    title: string;
    pids: readonly (number | string)[];
    requireNids?: unknown;
}

function dependencyOrder(chapters: readonly TrainingProgressNode[]) {
    const ids = new Set(chapters.map((node) => node._id));
    if (!chapters.length || ids.size !== chapters.length
        || chapters.some((node) => !Number.isSafeInteger(node._id) || node._id <= 0
            || !Array.isArray(node.pids) || !Array.isArray(node.requireNids))) {
        throw new Error('章节编号或先修关系格式无效，请检查高级模式中的训练计划。');
    }
    const remaining = new Map<number, number>();
    const dependents = new Map<number, number[]>();
    for (const node of chapters) {
        const requirements = [...new Set(node.requireNids as number[])];
        if (requirements.some((id) => !Number.isSafeInteger(id) || !ids.has(id))) {
            throw new Error(`“${node.title}”的先修章节不存在，请在高级模式中修正。`);
        }
        remaining.set(node._id, requirements.length);
        for (const id of requirements) {
            if (!dependents.has(id)) dependents.set(id, []);
            dependents.get(id)!.push(node._id);
        }
    }
    const order = chapters.filter((node) => !remaining.get(node._id)).map((node) => node._id);
    for (let at = 0; at < order.length; at++) {
        for (const id of dependents.get(order[at]) || []) {
            remaining.set(id, remaining.get(id)! - 1);
            if (!remaining.get(id)) order.push(id);
        }
    }
    return order;
}

export function validateTrainingDependencies(chapters: readonly TrainingProgressNode[]): void {
    if (dependencyOrder(chapters).length !== chapters.length) {
        throw new Error('先修章节存在循环依赖，请在高级模式中修正（章节不能依赖自己或互相依赖）。');
    }
}

/** Completion order is independent of the teacher's chosen display order. */
export function calculateTrainingProgress(
    chapters: readonly TrainingProgressNode[], statuses: Record<string, { status?: number }>, acceptedStatus = 1,
) {
    const pids = new Set(chapters.flatMap((node) => node.pids.map(Number)).filter((pid) => Number.isSafeInteger(pid) && pid > 0));
    const donePids = new Set([...pids].filter((pid) => statuses[pid]?.status === acceptedStatus));
    const attemptedPids = new Set([...pids].filter((pid) => !!statuses[pid]?.status));
    const ndict = Object.fromEntries(chapters.map((node) => [node._id, node]));
    const doneNids = new Set<number>();
    let order: number[] = [];
    try { order = dependencyOrder(chapters); } catch { /* Old malformed plans remain closed until a teacher repairs them. */ }
    for (const id of order) {
        const node = ndict[id];
        if ((node.requireNids as number[]).every((requirement) => doneNids.has(requirement))
            && node.pids.every((pid) => donePids.has(Number(pid)))) doneNids.add(id);
    }
    const traversable = new Set(order);
    const nsdict = Object.fromEntries(chapters.map((node) => {
        const nodePids = [...new Set(node.pids.map(Number))];
        const isInvalid = !traversable.has(node._id)
            || !(node.requireNids as number[]).every((id) => doneNids.has(id));
        const isDone = doneNids.has(node._id);
        const isProgress = !isInvalid && !isDone && nodePids.some((pid) => attemptedPids.has(pid));
        return [node._id, {
            progress: nodePids.length ? Math.floor(100 * nodePids.filter((pid) => donePids.has(pid)).length / nodePids.length) : 100,
            isDone, isInvalid, isProgress, isOpen: !isInvalid && !isDone && !isProgress,
        }];
    }));
    return { ndict, nsdict, summary: {
        donePids: [...donePids], doneNids: [...doneNids], done: !!chapters.length && doneNids.size === chapters.length,
    } };
}
