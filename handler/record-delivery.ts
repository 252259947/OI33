/** Drain only the batch taken before awaiting. Updates arriving during an async
 * permission check/send remain queued, including a newer state of the same rid. */
export function installRecordQueueDelivery(h: any) {
    if (h.constructor.name !== 'RecordMainConnectionHandler' || !(h.queue instanceof Map)
        || h.__oi33RecordQueueDelivery) return;
    h.__oi33RecordQueueDelivery = true;
    let flushing: Promise<void> | null = null;
    h.queueClear = function () {
        if (flushing) return flushing;
        let failed = false;
        const run = async () => {
            while (this.queue.size) {
                const batch = [...this.queue.entries()] as [string, () => Promise<any>][];
                this.queue.clear();
                for (let i = 0; i < batch.length; i++) {
                    try {
                        await this.send(await batch[i][1]());
                    } catch (error) {
                        failed = true;
                        // Preserve unsent work without replacing fresher updates.
                        // Retry only on a later native drain, never a failure loop.
                        for (const [rid, makePayload] of batch.slice(i)) {
                            if (!this.queue.has(rid)) this.queue.set(rid, makePayload);
                        }
                        throw error;
                    }
                }
            }
        };
        flushing = Promise.resolve().then(run).finally(() => {
            flushing = null;
            // A new update may arrive after run's last check but before this
            // microtask. Its leading-only native throttle may not fire again.
            if (!failed && this.queue.size) return this.queueClear();
        });
        return flushing;
    };
}
