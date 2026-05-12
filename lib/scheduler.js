'use strict';

function isDue(cat) {
    if (!cat.enabled) return false;
    if (cat.lastPolled === 0) return true;
    const slot = ts => Math.floor(ts / cat.intervalMs);
    return slot(Date.now()) > slot(cat.lastPolled);
}

function alignedStart(nowMs) {
    const ms = nowMs % 1000;
    return ms === 0 ? 1000 : 1000 - ms;
}

function createScheduler(onTick) {
    let handle = null;

    function start() {
        const delay = alignedStart(Date.now());
        setTimeout(() => {
            onTick();
            handle = setInterval(onTick, 1000);
        }, delay);
    }

    function stop() {
        if (handle) { clearInterval(handle); handle = null; }
    }

    return { start, stop };
}

module.exports = { isDue, alignedStart, createScheduler };
