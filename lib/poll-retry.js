'use strict';

// Quick retry of the charging poll (1.6.2). Octopus fails flexPlannedDispatches (KT-CT-4340)
// and sometimes devices.preferences (KT-CT-4339) for a few minutes around :00 and :30.
const RETRY_CODES = ['KT-CT-4340', 'KT-CT-4339'];

// Delay before retry 1, 2, 3; every later retry waits as long as the last one.
const RETRY_DELAYS_MS = [30000, 60000, 120000];

// Octopus allows 5 flexPlannedDispatches queries a minute; stay at 3 or fewer.
const DISPATCH_RATE_MAX = 3;
const DISPATCH_RATE_WINDOW_MS = 60000;

// A backward wall-clock step of at least this much is a real clock change (lib/scheduler.js
// re-polls after one); a smaller step is an NTP correction and is ignored.
const CLOCK_STEP_BACK_MS = 60 * 1000;

function retryDelay(retryNo) {
    const i = Math.min(Math.max(retryNo, 1), RETRY_DELAYS_MS.length) - 1;
    return RETRY_DELAYS_MS[i];
}

function isRetryable(err) {
    return !!err && RETRY_CODES.includes(err.code);
}

// Start of the next interval slot, counted from the epoch as the scheduler's isDue does.
function nextSlotStart(nowMs, intervalMs) {
    return (Math.floor(nowMs / intervalMs) + 1) * intervalMs;
}

// Sliding record of query times. A query at time t counts against every closed window
// [t, t + windowMs]; nextAllowedAt gives the earliest time one more query keeps every
// such window at or under max.
function createRateWindow({ max = DISPATCH_RATE_MAX, windowMs = DISPATCH_RATE_WINDOW_MS } = {}) {
    let times = [];
    // A time after `now` is left from before the wall clock stepped back. After a large step
    // it no longer counts; after a small one (an NTP correction) it counts as made now.
    const recentAt = (now) => times
        .filter((t) => t - now < CLOCK_STEP_BACK_MS)
        .map((t) => Math.min(t, now))
        .filter((t) => now - t <= windowMs);
    const prune = (now) => { times = recentAt(now); };
    return {
        record(now = Date.now()) {
            prune(now);
            times.push(now);
        },
        // Read-only: asking must not change the window.
        nextAllowedAt(now = Date.now()) {
            const recent = recentAt(now).sort((a, b) => a - b);
            if (recent.length < max) return now;
            return recent[recent.length - max] + windowMs + 1;
        },
    };
}

function formatDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

module.exports = {
    RETRY_CODES, RETRY_DELAYS_MS, DISPATCH_RATE_MAX, DISPATCH_RATE_WINDOW_MS, CLOCK_STEP_BACK_MS,
    retryDelay, isRetryable, nextSlotStart, createRateWindow, formatDuration,
};
