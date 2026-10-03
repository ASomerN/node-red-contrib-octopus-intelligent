'use strict';
const { validateTime, validateLimit } = require('./preferences');

const COMMAND_KEYS = ['set_limit', 'set_time', 'set_timezone', 'set_smart_charging', 'set_charge_cap'];

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
        if (typeof tz === 'string' && tz.trim().length > 0) {
            actions.push({ type: 'timezone', timezone: tz.trim() });
        }
    }

    if (has('set_smart_charging') && typeof payload.set_smart_charging === 'boolean') {
        actions.push({ type: 'smart_charging', enabled: payload.set_smart_charging });
    }

    if (has('set_charge_cap') && typeof payload.set_charge_cap === 'boolean') {
        actions.push({ type: 'charge_cap', enabled: payload.set_charge_cap });
    }

    return { actions, errors, hasCommand };
}

module.exports = { planCommands };
