// lib/categories/electricity.js
'use strict';

const RATES_QUERY = `
query getElectricityRates($account: String!) {
    account(accountNumber: $account) {
        electricityAgreements {
            validFrom validTo
            tariff {
                ... on TariffType { productCode standingCharge }
                ... on StandardTariff { productCode standingCharge unitRate }
                ... on HalfHourlyTariff { productCode standingCharge }
                ... on DayNightTariff { productCode standingCharge }
                ... on FourRateEvTariff { productCode standingCharge }
                ... on PrepayTariff { productCode standingCharge unitRate }
            }
        }
    }
}`;

const CONSUMPTION_QUERY = `
query getElectricityConsumption($account: String!, $startAt: DateTime!, $timezone: String!) {
    account(accountNumber: $account) {
        properties {
            electricityMeterPoints {
                mpan
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

// Tariff productCodes containing "OUTGOING" are export agreements (e.g. AGILE-OUTGOING-19-05-13).
// We surface both import and export tariff metadata as separate fields.
function parseRatesResponse(data) {
    const all = (data.account || {}).electricityAgreements || [];
    const isExport = (a) => ((a.tariff || {}).productCode || '').includes('OUTGOING');
    const importAgreements = all.filter(a => !isExport(a));
    const exportAgreements = all.filter(isExport);

    const fieldsFor = (prefix, agreements) => {
        const latest = agreements[0];
        const tariff = (latest && latest.tariff) || {};
        return {
            [`${prefix}_unit_rate`]: tariff.unitRate ?? null,
            [`${prefix}_standing_charge`]: tariff.standingCharge ?? null,
            [`${prefix}_tariff_code`]: tariff.productCode || null,
            [`${prefix}_valid_from`]: (latest && latest.validFrom) || null,
            [`${prefix}_valid_to`]: (latest && latest.validTo) || null,
        };
    };

    return {
        ...fieldsFor('electricity', importAgreements),
        ...fieldsFor('electricity_export', exportAgreements),
        electricity_rates_error: null
    };
}

// Picks the latest consumption edge for a given MPAN out of the query response.
function _findEntryForMpan(data, mpan) {
    if (!mpan) return null;
    const points = ((data.account || {}).properties || [])[0];
    const meterPoints = points ? (points.electricityMeterPoints || []) : [];
    const mp = meterPoints.find(p => p.mpan === mpan);
    if (!mp) return null;
    const meter = (mp.meters || [])[0];
    const edges = ((meter && meter.consumption) || {}).edges || [];
    return edges.length > 0 ? edges[edges.length - 1].node : null;
}

// Parses both import and export consumption from one response, given both MPANs.
// Either MPAN may be null on accounts without that direction — the corresponding
// fields will be null without affecting the other direction.
function parseConsumptionResponse(data, importMpan, exportMpan) {
    const importEntry = _findEntryForMpan(data, importMpan);
    const exportEntry = _findEntryForMpan(data, exportMpan);
    return {
        electricity_consumption_kwh: importEntry ? parseFloat(importEntry.value) : null,
        electricity_consumption_cost: null,
        electricity_consumption_from: importEntry ? importEntry.startAt : null,
        electricity_consumption_to: importEntry ? importEntry.endAt : null,
        electricity_export_consumption_kwh: exportEntry ? parseFloat(exportEntry.value) : null,
        electricity_export_consumption_from: exportEntry ? exportEntry.startAt : null,
        electricity_export_consumption_to: exportEntry ? exportEntry.endAt : null,
        electricity_consumption_error: null
    };
}

const defaultData = {
    electricity_unit_rate: null,
    electricity_standing_charge: null,
    electricity_tariff_code: null,
    electricity_valid_from: null,
    electricity_valid_to: null,
    electricity_export_unit_rate: null,
    electricity_export_standing_charge: null,
    electricity_export_tariff_code: null,
    electricity_export_valid_from: null,
    electricity_export_valid_to: null,
    electricity_rates_error: null,
    electricity_consumption_kwh: null,
    electricity_consumption_cost: null,
    electricity_consumption_from: null,
    electricity_consumption_to: null,
    electricity_export_consumption_kwh: null,
    electricity_export_consumption_from: null,
    electricity_export_consumption_to: null,
    electricity_consumption_error: null
};

module.exports = {
    buildRatesQuery,
    buildConsumptionQuery,
    parseRatesResponse,
    parseConsumptionResponse,
    defaultData
};
