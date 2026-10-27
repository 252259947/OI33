// The native group/star filters keep ownership of inline display. Our class
// intersects with those filters and never changes their row order or ranks.
export function installScoreboardUsability(scope: ParentNode = document) {
    const input = scope.querySelector<HTMLInputElement>('#oi33-scoreboard-query');
    if (!input || input.dataset.oi33Attached) return;
    const section = input.closest('.section');
    if (!section) return;
    input.dataset.oi33Attached = 'true';
    const count = section.querySelector('[data-scoreboard-count]');
    const empty = section.querySelector<HTMLElement>('[data-scoreboard-empty]');
    let frame = 0;
    let lastWidth = 0;
    const render = () => {
        frame = 0;
        const term = input.value.trim().toLocaleLowerCase();
        const rows = [...section.querySelectorAll<HTMLTableRowElement>('.oi33-scoreboard tbody > tr')];
        let visible = 0;
        for (const row of rows) {
            const user = row.querySelector('.col--user');
            const name = user?.querySelector('.user-profile-name')?.textContent || user?.textContent || '';
            const uid = user?.querySelector<HTMLElement>('[data-uid]')?.dataset.uid || '';
            const match = !term || name.trim().toLocaleLowerCase().includes(term) || uid === term;
            row.classList.toggle('oi33-scoreboard-search-hidden', !match);
            if (match && getComputedStyle(row).display !== 'none') visible += 1;
        }
        const label = `显示 ${visible} / ${rows.length} 人`;
        if (count && count.textContent !== label) count.textContent = label;
        if (empty) empty.hidden = visible !== 0;
        for (const table of section.querySelectorAll<HTMLTableElement>('.oi33-scoreboard table')) {
            // Widths come from this table so the native detached header stays
            // aligned, including rules with extra summary columns.
            const first = Array.from(table.rows).find(row => row.getBoundingClientRect().width > 0);
            if (!first) continue;
            let offset = 0;
            for (const cell of Array.from(first.cells)) {
                const frozen = ['col--rank', 'col--user', 'col--total_score'].some(c => cell.classList.contains(c));
                for (const row of Array.from(table.rows)) {
                    const target = row.cells[cell.cellIndex];
                    if (!target) continue;
                    target.classList.toggle('oi33-scoreboard-frozen', frozen);
                    if (frozen && target.style.getPropertyValue('--oi33-freeze-left') !== `${offset}px`) {
                        target.style.setProperty('--oi33-freeze-left', `${offset}px`);
                    }
                }
                if (frozen) offset += cell.getBoundingClientRect().width;
            }
        }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
    input.addEventListener('input', schedule);
    section.querySelector('[data-scoreboard-clear]')?.addEventListener('click', () => {
        input.value = ''; schedule(); input.focus();
    });
    // Covers native asynchronous star/group filters and live scoreboard PJAX.
    const observer = new MutationObserver(schedule);
    observer.observe(section, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    const resize = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width;
        if (width !== lastWidth) { lastWidth = width; schedule(); }
    });
    resize.observe(section);
    schedule();
    return () => { observer.disconnect(); resize.disconnect(); cancelAnimationFrame(frame); delete input.dataset.oi33Attached; };
}
