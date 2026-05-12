'use strict';

// wheelOfFortuneSpinsAllowed is the non-deprecated successor to wheelOfFortuneSpins.
// It lives on api.backend.octopus.energy (requires User-Agent header — handled in
// lib/graphql.js). The maxSpinsPerMonth / usedSpinsThisMonth fields from the old
// query were not migrated and return null.
const QUERY = `
query getWheelOfFortuneSpinsAllowed($accountNumber: String!) {
    electricity: wheelOfFortuneSpinsAllowed(fuelType: ELECTRICITY, accountNumber: $accountNumber) {
        spinsAllowed
    }
    gas: wheelOfFortuneSpinsAllowed(fuelType: GAS, accountNumber: $accountNumber) {
        spinsAllowed
    }
}`;

function buildQuery(account) {
    return {
        query: QUERY,
        variables: { accountNumber: account },
        hostname: 'api.backend.octopus.energy'
    };
}

function parseResponse(data) {
    const elec = data.electricity || {};
    const gas = data.gas || {};
    return {
        wheel_of_fortune_electricity_spins: elec.spinsAllowed ?? 0,
        wheel_of_fortune_electricity_max: null,
        wheel_of_fortune_electricity_used: null,
        wheel_of_fortune_gas_spins: gas.spinsAllowed ?? 0,
        wheel_of_fortune_gas_max: null,
        wheel_of_fortune_gas_used: null,
        wheel_of_fortune_error: null
    };
}

const defaultData = {
    wheel_of_fortune_electricity_spins: null,
    wheel_of_fortune_electricity_max: null,
    wheel_of_fortune_electricity_used: null,
    wheel_of_fortune_gas_spins: null,
    wheel_of_fortune_gas_max: null,
    wheel_of_fortune_gas_used: null,
    wheel_of_fortune_error: null
};

module.exports = { buildQuery, parseResponse, defaultData };
