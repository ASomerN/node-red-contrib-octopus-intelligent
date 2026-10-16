// lib/categories/smartflex-vehicle.js
'use strict';
const { toNumber, capStrings } = require('../values');

// v1.7.0: SmartFlex vehicle / charge point details, alerts and the last 5 charging
// sessions. Field names verified by live introspection (6 Oct 2026).
// Kraken sends Decimal fields as strings, so every number goes through toNumber().
// device_state is NOT read here: status is non-null on the device, so an error on it
// (KT-CT-4360 has been seen) nulls the device and then the whole list. The charging poll
// already reads status under a tolerated alias every refresh interval and sets device_state.
// A charge point is listed as ELECTRIC_VEHICLES too, so it always has a charging poll.

const { graphqlError, truncate } = require('../graphql-errors');

const SESSION_FIELDS = `
            chargingSessions(last: 5) {
                edges { node { ... on SmartFlexChargingSession {
                    start end stateOfChargeChange stateOfChargeFinal
                    energyAdded { value unit }
                    cost { amount currency }
                    type
                    problems { __typename }
                } } }
            }`;

const QUERY = `
query smartflexVehicle($account: String!) {
    devices(accountNumber: $account) {
        __typename
        id
        deviceType
        alerts { message publishedAt }
        ... on SmartFlexVehicle {
            make model vehicleBatterySize chargePointPowerOutput${SESSION_FIELDS}
        }
        ... on SmartFlexChargePoint {
            make model vehicleBatterySize chargePointPowerOutput${SESSION_FIELDS}
        }
    }
}`;

const VEHICLE_TYPENAMES = ['SmartFlexVehicle', 'SmartFlexChargePoint'];

function buildQuery(account) {
    return { query: QUERY, variables: { account } };
}

// energyAdded comes with its unit. KILOWATT_HOUR is what Octopus sends today; WATT_HOUR is
// converted so kwh_added (and the kWh sensor) is never out by 1000.
function energyKwh(energy) {
    if (!energy) return null;
    const value = toNumber(energy.value);
    if (value === null) return null;
    return energy.unit === 'WATT_HOUR' ? value / 1000 : value;
}

function mapSession(n) {
    return {
        start: n.start || null,
        end: n.end || null,
        kwh_added: energyKwh(n.energyAdded),
        soc_change: toNumber(n.stateOfChargeChange),
        soc_final: toNumber(n.stateOfChargeFinal),
        type: n.type || null,
        cost: n.cost ? { amount: toNumber(n.cost.amount), currency: n.cost.currency || null } : null,
        problems: (n.problems || []).filter(Boolean).map(p => p.__typename),
    };
}

function startTime(s) {
    const t = Date.parse(s.start);
    return Number.isNaN(t) ? -Infinity : t;
}

// Alerts go into the retained state JSON and into Home Assistant attributes (16 KiB recorder
// limit), so keep only the newest few and cut long messages.
const MAX_ALERTS = 10;
const MAX_ALERT_MESSAGE = 250;

function alertTime(a) {
    const t = Date.parse(a.published_at);
    return Number.isNaN(t) ? -Infinity : t;
}

function mapAlerts(alerts) {
    return (alerts || [])
        .filter(Boolean)
        .map(a => ({
            message: a.message ? truncate(a.message, MAX_ALERT_MESSAGE) : null,
            published_at: a.publishedAt || null,
        }))
        .sort((a, b) => alertTime(b) - alertTime(a))
        .slice(0, MAX_ALERTS);
}

function pickDevice(devices, deviceId) {
    return devices.find(d => d && deviceId && d.id === deviceId)
        || devices.find(d => d && VEHICLE_TYPENAMES.includes(d.__typename))
        || null;
}

function freshDefaults() {
    return { ...defaultData, device_alerts: [], charging_sessions: [] };
}

function parseResponse(data, deviceId) {
    const device = pickDevice((data && data.devices) || [], deviceId);
    if (!device) return freshDefaults();

    const edges = (device.chargingSessions && device.chargingSessions.edges) || [];
    const sessions = edges
        .map(e => e && e.node)
        .filter(n => n && n.start)
        .map(mapSession)
        .sort((a, b) => startTime(b) - startTime(a));
    const last = sessions.find(s => s.end) || null;

    return {
        vehicle_make: device.make || null,
        vehicle_model: device.model || null,
        vehicle_battery_kwh: toNumber(device.vehicleBatterySize),
        charger_power_kw: toNumber(device.chargePointPowerOutput),
        device_alerts: mapAlerts(device.alerts),
        last_session: last,
        charging_sessions: sessions,
        last_session_kwh: last ? last.kwh_added : null,
        last_session_soc_final: last ? last.soc_final : null,
        last_session_problem: last ? last.problems.length > 0 : null,
        smartflex_vehicle_error: null,
    };
}

// Device fields of the query and the payload fields built from each. When Kraken fails one
// (a partial error nulls it), its payload fields are left out so the last values are kept.
const FIELD_OUTPUTS = {
    make: ['vehicle_make'],
    model: ['vehicle_model'],
    vehicleBatterySize: ['vehicle_battery_kwh'],
    chargePointPowerOutput: ['charger_power_kw'],
    alerts: ['device_alerts'],
    chargingSessions: ['charging_sessions', 'last_session', 'last_session_kwh', 'last_session_soc_final', 'last_session_problem'],
};

// Parses the whole GraphQL body ({ data, errors }) and tolerates partial errors: an error on
// one field of the vehicle (e.g. chargingSessions) keeps everything else, leaves that field's
// payload fields out (the merge keeps the last values) and sets a short "KT-CT-xxxx: message"
// smartflex_vehicle_error. Errors on other devices are ignored. Throws when there is no
// usable vehicle data at all.
function parseGraphqlResponse(body, deviceId) {
    const errors = Array.isArray(body && body.errors) && body.errors.length ? body.errors : null;
    const data = (body && body.data) || null;
    if (!data) {
        if (errors) throw graphqlError(errors, 'SmartFlex vehicle query failed');
        throw new Error('Response missing data');
    }
    if (!errors) return parseResponse(data, deviceId);

    const devices = Array.isArray(data.devices) ? data.devices : null;
    // With errors, the discovered device must be the one in the list: when the error nulled
    // it, falling back to another vehicle would show that vehicle's data as this one's.
    // Throwing keeps the last values.
    const device = !devices ? null
        : deviceId ? (devices.find(d => d && d.id === deviceId) || null)
            : pickDevice(devices, null);
    if (!device) throw graphqlError(errors, 'SmartFlex vehicle query failed');

    const index = devices.indexOf(device);
    const relevant = errors.filter((e) => !(Array.isArray(e && e.path) && e.path[0] === 'devices'
        && Number.isInteger(e.path[1]) && e.path[1] !== index));
    const result = parseResponse(data, deviceId);
    if (relevant.length === 0) return result;

    for (const e of relevant) {
        const field = Array.isArray(e && e.path) && e.path[1] === index ? e.path[2] : null;
        // A field that still came back (the error was deeper) is used as it is.
        if (field && FIELD_OUTPUTS[field] && (device[field] === null || device[field] === undefined)) {
            for (const k of FIELD_OUTPUTS[field]) delete result[k];
        }
    }
    result.smartflex_vehicle_error = graphqlError(relevant, 'SmartFlex vehicle query failed').message;
    return result;
}

const defaultData = {
    vehicle_make: null,
    vehicle_model: null,
    vehicle_battery_kwh: null,
    charger_power_kw: null,
    device_alerts: [],
    last_session: null,
    charging_sessions: [],
    last_session_kwh: null,
    last_session_soc_final: null,
    last_session_problem: null,
    smartflex_vehicle_error: null,
};

module.exports = { buildQuery, parseResponse: capStrings(parseResponse), parseGraphqlResponse: capStrings(parseGraphqlResponse), defaultData };
