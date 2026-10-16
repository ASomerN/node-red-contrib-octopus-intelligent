// lib/categories/smartflex-inverter.js
'use strict';
const { toNumber, capStrings } = require('../values');

// v1.7.0 EXPERIMENTAL: SmartFlex inverter details and live telemetry.
// Field names come from live schema introspection (6 Oct 2026), but no account we can
// test has an inverter, so the response shape is NOT live-verified. This category is
// off by default and only runs when the editor option is ticked.
// Kraken sends Decimal fields as strings, so every number goes through toNumber().

const QUERY = `
query smartflexInverter($account: String!) {
    devices(accountNumber: $account) {
        __typename
        id
        ... on SmartFlexInverter {
            make model
            details { solar { peakSolarPowerInKw } }
            telemetry {
                inverter { connectionStatus powerInKw }
                battery { connectionStatus powerInKw stateOfCharge }
                solar { powerInKw }
                grid { powerInKw }
                site { consumptionInKw exportInKw }
            }
        }
    }
}`;

// Connection status values treated as online. The enum has not been seen live.
const ONLINE_STATES = ['CONNECTED', 'ONLINE'];

function buildQuery(account) {
    return { query: QUERY, variables: { account } };
}

// The schema may return a single reading or a list of readings; use the latest.
function latest(x) {
    if (Array.isArray(x)) return x.length ? (x[x.length - 1] || {}) : {};
    return x || {};
}

function pickDevice(devices, deviceId) {
    return devices.find(d => d && deviceId && d.id === deviceId)
        || devices.find(d => d && d.__typename === 'SmartFlexInverter')
        || null;
}

function parseResponse(data, deviceId) {
    const device = pickDevice((data && data.devices) || [], deviceId);
    if (!device) return { ...defaultData };

    const details = latest(device.details);
    const telemetry = latest(device.telemetry);
    const inv = latest(telemetry.inverter);
    const battery = latest(telemetry.battery);
    const solar = latest(telemetry.solar);
    const grid = latest(telemetry.grid);
    const site = latest(telemetry.site);
    const connection = inv.connectionStatus || null;

    return {
        inverter_make: device.make || null,
        inverter_model: device.model || null,
        solar_peak_kw: toNumber(latest(details.solar).peakSolarPowerInKw),
        inverter_power_kw: toNumber(inv.powerInKw),
        inverter_connection_status: connection,
        inverter_online: connection === null ? null : ONLINE_STATES.includes(connection),
        home_battery_power_kw: toNumber(battery.powerInKw),
        home_battery_soc: toNumber(battery.stateOfCharge),
        solar_power_kw: toNumber(solar.powerInKw),
        grid_power_kw: toNumber(grid.powerInKw),
        site_consumption_kw: toNumber(site.consumptionInKw),
        site_export_kw: toNumber(site.exportInKw),
        smartflex_inverter_error: null,
    };
}

const defaultData = {
    inverter_make: null,
    inverter_model: null,
    solar_peak_kw: null,
    inverter_power_kw: null,
    inverter_connection_status: null,
    inverter_online: null,
    home_battery_power_kw: null,
    home_battery_soc: null,
    solar_power_kw: null,
    grid_power_kw: null,
    site_consumption_kw: null,
    site_export_kw: null,
    smartflex_inverter_error: null,
};

module.exports = { buildQuery, parseResponse: capStrings(parseResponse), defaultData };
