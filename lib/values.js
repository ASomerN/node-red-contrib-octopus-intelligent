'use strict';

// Kraken numeric scalars can arrive as numbers or as JSON strings ("12.5"). A value that is
// not a finite number (null, "abc", "Infinity", 1e400 in the JSON, a list) becomes null, so
// NaN and Infinity never reach msg.payload or Home Assistant.
function toNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
}

// A value as text for an error message, cut to `max` characters. Never throws: a Symbol, an
// object with no prototype or a throwing toString still gives some text.
function shown(value, max = 40) {
    let s;
    try {
        s = String(value);
    } catch (e) {
        s = Object.prototype.toString.call(value);
    }
    return s.length > max ? `${s.slice(0, max)}...` : s;
}

// Home Assistant rejects a state of 255 characters or more, and the entity then stops updating.
const MAX_STATE_LENGTH = 254;

// Text from the API that becomes an entity state (a tariff code, a time Octopus sent that could
// not be read, a charge source) is cut to MAX_STATE_LENGTH.
function capText(value) {
    return typeof value === 'string' && value.length > MAX_STATE_LENGTH
        ? `${value.slice(0, MAX_STATE_LENGTH - 3)}...` : value;
}

// `parse` with every top-level text field of its result cut by capText. Lists and objects
// (attributes such as the rate list) are left as they are.
function capStrings(parse) {
    return function capped(...args) {
        const out = parse(...args);
        if (!out || typeof out !== 'object') return out;
        const copy = Object.assign({}, out);
        for (const k of Object.keys(copy)) copy[k] = capText(copy[k]);
        return copy;
    };
}

module.exports = { toNumber, shown, capText, capStrings, MAX_STATE_LENGTH };
