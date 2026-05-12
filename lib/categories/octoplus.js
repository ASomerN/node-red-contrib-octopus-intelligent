// lib/categories/octoplus.js
'use strict';

const QUERY = `
query getOctoplusInfo($account: String!) {
    octoplusAccountInfo(accountNumber: $account) {
        isOctoplusEnrolled enrollmentStatus isLoyaltyPointsUser
    }
}`;

function buildQuery(account) {
    return { query: QUERY, variables: { account } };
}

function parseResponse(data) {
    const info = data.octoplusAccountInfo || {};
    return {
        octoplus_enrolled: info.isOctoplusEnrolled ?? null,
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

module.exports = { buildQuery, parseResponse, defaultData };
