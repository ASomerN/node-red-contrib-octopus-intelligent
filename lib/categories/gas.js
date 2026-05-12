// lib/categories/gas.js
'use strict';

// GasTariffType is a single object type (not a union) — direct field access, no fragments.
const RATES_QUERY = `
query getGasRates($account: String!) {
    account(accountNumber: $account) {
        gasAgreements {
            validFrom validTo
            tariff {
                productCode
                standingCharge
                unitRate
            }
        }
    }
}`;

const CONSUMPTION_QUERY = `
query getGasConsumption($account: String!, $startAt: DateTime!, $timezone: String!) {
    account(accountNumber: $account) {
        properties {
            gasMeterPoints {
                meters {
                    consumption(startAt: $startAt, last: 1, grouping: DAY, timezone: $timezone) {
                        edges { node { startAt endAt value } }
                    }
                }
            }
        }
    }
}`;

function buildRatesQuery(account) {
    return { query: RATES_QUERY, variables: { account } };
}

function buildConsumptionQuery(account, timezone) {
    const tz = timezone || 'UTC';
    const startAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    return { query: CONSUMPTION_QUERY, variables: { account, startAt, timezone: tz } };
}

function parseRatesResponse(data) {
    const all = (data.account || {}).gasAgreements || [];
    const agreements = all.filter(a => !((a.tariff || {}).productCode || '').includes('OUTGOING'));
    if (agreements.length === 0) {
        return {
            gas_unit_rate: null, gas_standing_charge: null, gas_tariff_code: null,
            gas_valid_from: null, gas_valid_to: null, gas_rates_error: null
        };
    }
    const latest = agreements[0];
    const tariff = latest.tariff || {};
    return {
        gas_unit_rate: tariff.unitRate ?? null,
        gas_standing_charge: tariff.standingCharge ?? null,
        gas_tariff_code: tariff.productCode || null,
        gas_valid_from: latest.validFrom || null,
        gas_valid_to: latest.validTo || null,
        gas_rates_error: null
    };
}

function parseConsumptionResponse(data) {
    const points = ((data.account || {}).properties || [])[0];
    const meterPoint = points ? (points.gasMeterPoints || [])[0] : null;
    const meter = meterPoint ? (meterPoint.meters || [])[0] : null;
    const connection = meter ? meter.consumption : null;
    const edges = connection ? (connection.edges || []) : [];
    const entry = edges.length > 0 ? edges[edges.length - 1].node : null;
    if (!entry) {
        return {
            gas_consumption_kwh: null, gas_consumption_cost: null,
            gas_consumption_from: null, gas_consumption_to: null, gas_consumption_error: null
        };
    }
    return {
        gas_consumption_kwh: parseFloat(entry.value),
        gas_consumption_cost: null,
        gas_consumption_from: entry.startAt,
        gas_consumption_to: entry.endAt,
        gas_consumption_error: null
    };
}

const defaultData = {
    gas_unit_rate: null, gas_standing_charge: null, gas_tariff_code: null,
    gas_valid_from: null, gas_valid_to: null, gas_rates_error: null,
    gas_consumption_kwh: null, gas_consumption_cost: null,
    gas_consumption_from: null, gas_consumption_to: null, gas_consumption_error: null
};

module.exports = { buildRatesQuery, buildConsumptionQuery, parseRatesResponse, parseConsumptionResponse, defaultData };
