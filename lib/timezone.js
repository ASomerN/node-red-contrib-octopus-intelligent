'use strict';
const { shown } = require('./values');

// Longest IANA names are about 30 characters; the value is also an HA select state.
const MAX_TIMEZONE_LENGTH = 64;

function convertToTimezone(dateStr, tz) {
    if (!dateStr || typeof dateStr !== 'string') return dateStr;
    try {
        const date = new Date(dateStr.replace(' ', 'T'));
        if (isNaN(date.getTime())) return dateStr;
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false, hourCycle: 'h23'
        }).formatToParts(date);
        const get = (type) => (parts.find(p => p.type === type) || {}).value || '00';
        const y = get('year'), mo = get('month'), d = get('day');
        const h = get('hour'), mi = get('minute'), s = get('second');
        const localAsUtc = Date.UTC(
            parseInt(y, 10), parseInt(mo, 10) - 1, parseInt(d, 10),
            parseInt(h, 10), parseInt(mi, 10), parseInt(s, 10)
        );
        const offsetMins = Math.round((localAsUtc - date.getTime()) / 60000);
        const sign = offsetMins >= 0 ? '+' : '-';
        const absMin = Math.abs(offsetMins);
        const offsetStr = `${sign}${String(Math.floor(absMin / 60)).padStart(2, '0')}:${String(absMin % 60).padStart(2, '0')}`;
        return `${y}-${mo}-${d} ${h}:${mi}:${s}${offsetStr}`;
    } catch (e) {
        return dateStr;
    }
}

function resolveTimezone(nd) {
    try {
        const persisted = nd.context().get('timezone');
        if (persisted && typeof persisted === 'string' && persisted.trim().length > 0) {
            return persisted.trim();
        }
    } catch (e) {}
    const override = nd.timezoneOverride;
    if (override && typeof override === 'string' && override.trim().length > 0) {
        return override.trim();
    }
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch (e) {
        return 'UTC';
    }
}

// A timezone from set_timezone (input or MQTT): a non-empty IANA name that Intl knows, at most
// MAX_TIMEZONE_LENGTH characters. Trimmed. A wrong name used to be stored as it was, and every
// display time then kept the raw UTC text.
function validateTimezone(value) {
    const tz = typeof value === 'string' ? value.trim() : '';
    if (tz.length > 0 && tz.length <= MAX_TIMEZONE_LENGTH) {
        try {
            new Intl.DateTimeFormat('en-GB', { timeZone: tz });
            return { ok: true, timezone: tz };
        } catch (e) { /* unknown zone: fall through */ }
    }
    return { ok: false, error: `Invalid timezone '${shown(value)}' — must be an IANA name such as Europe/London` };
}

module.exports = { convertToTimezone, resolveTimezone, validateTimezone, MAX_TIMEZONE_LENGTH };
