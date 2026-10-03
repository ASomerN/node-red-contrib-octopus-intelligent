'use strict';

// Ready-by times offered by the Octopus app: every half hour, 00:00–23:30.
const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
    const h = String(Math.floor(i / 2)).padStart(2, '0');
    return `${h}:${i % 2 ? '30' : '00'}`;
});

function validateTime(time) {
    if (typeof time === 'string' && TIME_OPTIONS.includes(time)) {
        return { ok: true, time };
    }
    return {
        ok: false,
        error: `Invalid ready-by time '${time}' — must be HH:MM on the hour or half hour (00:00–23:30)`,
    };
}

function validateLimit(limit) {
    // Plain decimal numbers or numeric strings only: no truncating '8O' to 8 (parseInt) and no
    // coercing true/[90]/'0x5A'/'1e2' (Number). 0 is never a meaningful target.
    let n = NaN;
    if (typeof limit === 'number') n = limit;
    else if (typeof limit === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(limit)) n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, error: `Invalid charge limit '${limit}' — must be a number between 5 and 100` };
    }
    const clamped = Math.min(100, Math.max(5, n));
    return { ok: true, limit: Math.round(clamped / 5) * 5 };
}

module.exports = { TIME_OPTIONS, validateTime, validateLimit };
