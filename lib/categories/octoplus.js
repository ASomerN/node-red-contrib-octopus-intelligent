// lib/categories/octoplus.js
'use strict';
const { capStrings } = require('../values');

const QUERY = `
query getOctoplusInfo($account: String!) {
    octoplusAccountInfo(accountNumber: $account) {
        enrollmentStatus isLoyaltyPointsUser
    }
}`;

function buildQuery(account) {
    return { query: QUERY, variables: { account } };
}

function parseResponse(data) {
    const info = data.octoplusAccountInfo || {};
    return {
        // isOctoplusEnrolled is deprecated by Kraken, so derive it from enrollmentStatus.
        octoplus_enrolled: info.enrollmentStatus ? info.enrollmentStatus === 'ENROLLED' : null,
        octoplus_enrollment_status: info.enrollmentStatus || null,
        octoplus_loyalty_points_user: info.isLoyaltyPointsUser ?? null,
        octoplus_error: null
    };
}

const defaultData = {
    octoplus_enrolled: null,
    octoplus_enrollment_status: null,
    octoplus_loyalty_points_user: null,
    octoplus_error: null
};

// Text fields cut to the HA state limit (lib/values.js).
module.exports = { buildQuery, parseResponse: capStrings(parseResponse), defaultData };
