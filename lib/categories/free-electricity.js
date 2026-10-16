// lib/categories/free-electricity.js
// Detects upcoming and active "Free Electricity" sessions (0p/kWh windows).
// Requires account number and MPAN from account discovery.
'use strict';
const { capStrings } = require('../values');

const QUERY = `
query getFreeElectricity($account: String!, $mpan: String!) {
    customerFlexibilityCampaignEvents(
        accountNumber: $account,
        supplyPointIdentifier: $mpan,
        campaignSlug: "free_electricity",
        first: 50
    ) {
        edges {
            node {
                code
                startAt
                endAt
            }
        }
    }
}`;

function buildQuery(account, mpan) {
    return { query: QUERY, variables: { account, mpan } };
}

function parseResponse(data) {
    const now = new Date();

    const edges = ((data.customerFlexibilityCampaignEvents || {}).edges) || [];
    const sessions = edges.map(e => ({ startAt: e.node.startAt, endAt: e.node.endAt }));

    // Filter to sessions not yet ended, sort by startAt ascending, take the first
    const future = sessions
        .filter(s => new Date(s.endAt) > now)
        .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));

    const next = future[0] || null;

    const active = next !== null && new Date(next.startAt) <= now && new Date(next.endAt) > now;
    const available = next !== null;

    return {
        free_electricity_active: active,
        free_electricity_available: available,
        free_electricity_start: next ? next.startAt : null,
        free_electricity_end: next ? next.endAt : null,
        free_electricity_error: null
    };
}

// Active flag for `nowMs` from the stored next session (state from parseResponse).
// Used on the node's 10 s tick so it switches at the session start/end, not at the next poll.
function activeFields(state, nowMs) {
    if (!state.free_electricity_start || !state.free_electricity_end) return {};
    return {
        free_electricity_active: new Date(state.free_electricity_start).getTime() <= nowMs
            && new Date(state.free_electricity_end).getTime() > nowMs,
    };
}

const defaultData = {
    free_electricity_active: null,
    free_electricity_available: null,
    free_electricity_start: null,
    free_electricity_end: null,
    free_electricity_error: null
};

// Text fields cut to the HA state limit (lib/values.js).
module.exports = { buildQuery, parseResponse: capStrings(parseResponse), activeFields, defaultData };
