// lib/categories/flex-planned-dispatches.js
'use strict';

const QUERY = `
query getFlexPlannedDispatches($deviceId: String!) {
    flexPlannedDispatches(deviceId: $deviceId) {
        start end type energyAddedKwh
    }
}`;

function buildQuery(deviceId) {
    return { query: QUERY, variables: { deviceId } };
}

function parseResponse(data) {
    const dispatches = data.flexPlannedDispatches || [];
    return {
        flex_planned_dispatches: dispatches.map(d => ({
            start: d.start,
            end: d.end,
            type: d.type || null,
            energy_kwh: d.energyAddedKwh !== null && d.energyAddedKwh !== undefined
                ? parseFloat(d.energyAddedKwh) : null
        })),
        flex_planned_dispatches_count: dispatches.length,
        flex_planned_dispatches_error: null
    };
}

const defaultData = {
    flex_planned_dispatches: [],
    flex_planned_dispatches_count: 0,
    flex_planned_dispatches_error: null
};

module.exports = { buildQuery, parseResponse, defaultData };
