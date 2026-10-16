'use strict';

// A tick running longer than this is treated as stuck: later ticks may run again.
// A busy tick can make about 17 requests, each allowed 30 s, so stay well above that.
const STUCK_TICK_MS = 10 * 60 * 1000;

// Monotonic clock: a wall-clock jump (e.g. NTP on a Pi) must not look like a stuck tick.
// `performance` is only a global from Node 16; package.json allows Node 14, so fall back
// to perf_hooks. Looked up on each call so test fake timers still apply.
const { performance: perfHooksPerformance } = require('perf_hooks');
const monotonicNow = () => (typeof performance !== 'undefined' ? performance : perfHooksPerformance).now();

// A backward wall-clock step of at least this much re-polls what was polled "in the future".
// A smaller step (an NTP correction of a second or two) only moves lastPolled back to now.
const { CLOCK_STEP_BACK_MS } = require('./poll-retry');

function isDue(cat) {
    if (!cat.enabled) return false;
    if (cat.lastPolled === 0) return true;
    // Polled "in the future": the wall clock has stepped back. After a large step, poll now
    // rather than wait for the clock to catch up. After a small one, treat it as polled now,
    // so a correction of a second or two does not re-poll every category.
    const nowMs = Date.now();
    if (cat.lastPolled > nowMs) {
        if (cat.lastPolled - nowMs >= CLOCK_STEP_BACK_MS) return true;
        cat.lastPolled = nowMs;
    }
    // A short retry after a failed token request (lib/poll-tick.js).
    if (cat.authRetryAt && Date.now() >= cat.authRetryAt) return true;
    const slot = ts => Math.floor(ts / cat.intervalMs);
    return slot(Date.now()) > slot(cat.lastPolled);
}

function alignedStart(nowMs) {
    const ms = nowMs % 1000;
    return ms === 0 ? 1000 : 1000 - ms;
}

function wrapWithInFlightGuard(fn, { maxMs = STUCK_TICK_MS, onStuck } = {}) {
    let inFlight = false;
    let startedAt = 0;
    let run = 0;
    return async function guarded(...args) {
        if (inFlight) {
            const age = monotonicNow() - startedAt;
            if (age < maxMs) return;
            if (onStuck) onStuck(age);
        }
        const id = ++run;
        inFlight = true;
        startedAt = monotonicNow();
        // The tick can ask whether a newer tick has replaced it, and stop.
        const isStale = () => id !== run;
        try {
            return await fn(...args, isStale);
        } finally {
            // Only the newest tick may clear the flag; a stuck tick that ends late must not.
            if (id === run) inFlight = false;
        }
    };
}

function createScheduler(onTick, { onStuck } = {}) {
    const guarded = wrapWithInFlightGuard(onTick, { onStuck });
    let startTimer = null;
    let handle = null;

    function start() {
        const delay = alignedStart(Date.now());
        startTimer = setTimeout(() => {
            startTimer = null;
            guarded();
            handle = setInterval(guarded, 1000);
        }, delay);
    }

    function stop() {
        if (startTimer) { clearTimeout(startTimer); startTimer = null; }
        if (handle) { clearInterval(handle); handle = null; }
    }

    return { start, stop };
}

module.exports = { isDue, alignedStart, createScheduler, wrapWithInFlightGuard, STUCK_TICK_MS, CLOCK_STEP_BACK_MS };
