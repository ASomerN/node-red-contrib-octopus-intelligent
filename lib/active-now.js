'use strict';
// "Active now" fields: values that depend on the clock, not only on what Octopus returned.
// Recomputed from the stored state on the node's 10 s tick, with no API calls.
const savingSessions = require('./categories/saving-sessions');
const freeElectricity = require('./categories/free-electricity');
const applicableRates = require('./categories/applicable-rates');

const RATE_PREFIXES = ['applicable_rates', 'electricity_export_rate'];

function activeFields(state, nowMs) {
    const out = Object.assign({},
        savingSessions.activeFields(state, nowMs),
        freeElectricity.activeFields(state, nowMs));
    for (const prefix of RATE_PREFIXES) {
        const slots = state[prefix];
        if (Array.isArray(slots) && slots.length > 0) {
            Object.assign(out, applicableRates.currentFields(slots, prefix, nowMs));
        }
    }
    return out;
}

// The recomputed fields whose value differs from `state`, or null when none do.
function changedActiveFields(state, nowMs) {
    const fresh = activeFields(state, nowMs);
    const changed = {};
    for (const [k, v] of Object.entries(fresh)) {
        if (!Object.is(state[k], v)) changed[k] = v; // Object.is: a NaN rate is not a change
    }
    return Object.keys(changed).length > 0 ? changed : null;
}

module.exports = { activeFields, changedActiveFields };
