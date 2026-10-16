'use strict';
const { validateTime, validateLimit } = require('./preferences');
const { validateTimezone } = require('./timezone');

// A short text form of a bad input value for the error message.
function shown(v) {
    let s;
    try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { s = String(v); }
    s = String(s);
    return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

const COMMAND_KEYS =['set_limit', 'set_time', 'set_timezone', 'set_smart_charging', 'set_charge_cap', 'set_boost'];

// Turns a msg.payload into independent actions. Supplied values are validated;
// fallbacks come from the API (confirmed*) and are passed through unvalidated.
function planCommands(payload, current) {
    const actions = [];
    const errors = [];
    const has = (k) => payload[k] !== undefined && payload[k] !== null;
    const hasCommand = COMMAND_KEYS.some(has);

    if (has('set_limit') || has('set_time')) {
        let limit = current.confirmedLimit;
        let time = current.confirmedTime;
        let valid = true;
        if (has('set_limit')) {
            const r = validateLimit(payload.set_limit);
            if (r.ok) limit = r.limit; else { errors.push(r.error); valid = false; }
        }
        if (has('set_time')) {
            const r = validateTime(payload.set_time);
            if (r.ok) time = r.time; else { errors.push(r.error); valid = false; }
        }
        if (valid) actions.push({ type: 'preferences', limit, time });
    }

    if (has('set_timezone')) {
        const tz = payload.set_timezone;
        // An empty text is ignored; anything else must be a timezone Intl knows.
        if (!(typeof tz === 'string' && tz.trim().length === 0)) {
            const r = validateTimezone(tz);
            if (r.ok) actions.push({ type: 'timezone', timezone: r.timezone });
            else errors.push(r.error);
        }
    }

    if (has('set_smart_charging') && typeof payload.set_smart_charging === 'boolean') {
        actions.push({ type: 'smart_charging', enabled: payload.set_smart_charging });
    }

    if (has('set_charge_cap') && typeof payload.set_charge_cap === 'boolean') {
        actions.push({ type: 'charge_cap', enabled: payload.set_charge_cap });
    }

    // true = BOOST (charge now, outside the plan), false = CANCEL. Booleans only: a boost
    // spends money, so "true", 1 or "ON" is reported as an error, not guessed at.
    if (has('set_boost')) {
        if (typeof payload.set_boost === 'boolean') {
            actions.push({ type: 'boost', enabled: payload.set_boost });
        } else {
            errors.push(`Invalid set_boost '${shown(payload.set_boost)}' — must be true or false`);
        }
    }

    return { actions, errors, hasCommand };
}

module.exports = { planCommands };
