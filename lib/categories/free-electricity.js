// lib/categories/free-electricity.js
// Detects upcoming and active "Free Electricity" sessions (0p/kWh windows).
// Requires account number and MPAN from account discovery.
'use strict';

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

const defaultData = {
    free_electricity_active: null,
    free_electricity_available: null,
    free_electricity_start: null,
    free_electricity_end: null,
    free_electricity_error: null
};

module.exports = { buildQuery, parseResponse, defaultData };
