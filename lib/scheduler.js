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

function wrapWithInFlightGuard(fn) {
    let inFlight = false;
    return async function guarded(...args) {
        if (inFlight) return;
        inFlight = true;
        try {
            return await fn(...args);
        } finally {
            inFlight = false;
        }
    };
}

function createScheduler(onTick) {
    const guarded = wrapWithInFlightGuard(onTick);
    let handle = null;

    function start() {
        const delay = alignedStart(Date.now());
        setTimeout(() => {
            guarded();
            handle = setInterval(guarded, 1000);
        }, delay);
    }

    function stop() {
        if (handle) { clearInterval(handle); handle = null; }
    }

    return { start, stop };
}

module.exports = { isDue, alignedStart, createScheduler, wrapWithInFlightGuard };
