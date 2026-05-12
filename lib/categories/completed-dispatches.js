// lib/categories/completed-dispatches.js
'use strict';

const QUERY = `
query getCompletedDispatches($account: String!) {
    completedDispatches(accountNumber: $account) {
        start end delta meta { source location }
    }
}`;

function buildQuery(account) {
    return { query: QUERY, variables: { account } };
}

function parseResponse(data) {
    const dispatches = data.completedDispatches || [];
    return {
        completed_dispatches: dispatches.map(d => ({
            start: d.start,
            end: d.end,
            delta_kwh: d.delta !== null && d.delta !== undefined ? parseFloat(d.delta) : null,
            source: (d.meta || {}).source || null
        })),
        completed_dispatches_count: dispatches.length,
        completed_dispatches_error: null
    };
}

const defaultData = {
    completed_dispatches: [],
    completed_dispatches_count: 0,
    completed_dispatches_error: null
};

module.exports = { buildQuery, parseResponse, defaultData };
