// lib/categories/intelligent.js
'use strict';
const { convertToTimezone } = require('../timezone');
const { isBoosting } = require('../boost');
const { toNumber, capStrings } = require('../values');
// Shared with discovery (lib/discovery.js); exported here as before.
const { statusNulledDevices } = require('../graphql-errors');

const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];

// Smart-charging switch state and boost state (currentState). The alias only makes its errors
// easy to recognise: `status` is non-null on the device and the list items are non-null too,
// so an error on `status` itself (KT-CT-4360 has been seen there) nulls `devices`, the nearest
// nullable field: the whole list, schedules included. The charging poll then asks again without this selection
// (buildDevicesQuery(account, false)).
const STATUS_SELECTION = `
        # Smart-charging switch state and boost state, under their own alias so an error on
        # status (KT-CT-4360 has been seen) can be told apart from other device errors.
        # currentState is BOOSTING while a boost charge runs.
        smartStatus: status {
            isSuspended
            currentState
        }`;

function devicesQuery(withStatus) {
    return `
query getDevices($account: String!) {
    devices(accountNumber: $account) {
        id
        deviceType
        preferences {
            ... on SmartFlexDevicePreferences {
                schedules {
                    dayOfWeek
                    time
                    max
                }
            }
        }
        # Separate alias: the Charge Cap field is non-null, so an error on it nulls its parent
        # selection (preferences is nullable). Keeping it apart stops such an error from
        # blanking the schedules above.
        chargeCap: preferences {
            ... on SmartFlexDevicePreferences {
                isChargingDurationCapped
            }
        }${withStatus ? STATUS_SELECTION : ''}
    }
}`;
}

const DEVICES_QUERY = devicesQuery(true);
const DEVICES_QUERY_NO_STATUS = devicesQuery(false);

const DISPATCH_QUERY = `
query getDispatches($deviceId: String!) {
    flexPlannedDispatches(deviceId: $deviceId) {
        start end type energyAddedKwh
    }
}`;

// withStatus false leaves out the smart-charging status (see STATUS_SELECTION).
function buildDevicesQuery(account, withStatus = true) {
    return { query: withStatus ? DEVICES_QUERY : DEVICES_QUERY_NO_STATUS, variables: { account } };
}

function buildDispatchQuery(deviceId) {
    return { query: DISPATCH_QUERY, variables: { deviceId } };
}

// Another device's entry can be null when Kraken failed one of its fields (review A11).
// preferredId: the EV discovery picked (the LIVE one, review L4). Used when it is listed, so
// every part of the charging poll reads the same device; otherwise the first EV.
function extractEvDevice(devices, preferredId) {
    const evs = (devices || []).filter(d => d && d.deviceType === 'ELECTRIC_VEHICLES');
    return (preferredId ? evs.find(d => d.id === preferredId) : null) || evs[0] || null;
}

// isChargingDurationCapped: ENABLED | DISABLED | NOT_APPLICABLE (live-verified 2026-09-29).
// Anything other than ENABLED/DISABLED (incl. missing) -> null.
function extractChargeCap(devices, preferredId) {
    const ev = extractEvDevice(devices, preferredId);
    const raw = ev && ev.chargeCap ? ev.chargeCap.isChargingDurationCapped : undefined;
    if (raw === 'ENABLED') return true;
    if (raw === 'DISABLED') return false;
    return null;
}

// status.isSuspended (alias smartStatus): true = smart charging suspended (switch OFF).
// Anything but a boolean (missing, null after an error) -> null (unknown).
function extractSuspended(devices, preferredId) {
    const ev = extractEvDevice(devices, preferredId);
    const raw = ev && ev.smartStatus ? ev.smartStatus.isSuspended : undefined;
    return typeof raw === 'boolean' ? raw : null;
}

// status.currentState (alias smartStatus) BOOSTING -> true, any other state -> false,
// missing -> null.
function extractBoosting(devices, preferredId) {
    const ev = extractEvDevice(devices, preferredId);
    const raw = ev && ev.smartStatus ? ev.smartStatus.currentState : undefined;
    return isBoosting(raw);
}

// status.currentState (alias smartStatus) as it is, e.g. SMART_CONTROL_IN_PROGRESS, BOOSTING,
// LOST_CONNECTION. Read here (every charging poll) so device_state and boosting always agree.
// Missing -> null.
function extractDeviceState(devices, preferredId) {
    const ev = extractEvDevice(devices, preferredId);
    const raw = ev && ev.smartStatus ? ev.smartStatus.currentState : undefined;
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function extractPreferences(devices, preferredId) {
    const ev = extractEvDevice(devices, preferredId);
    if (!ev || !ev.preferences) return { confirmed_limit: 80, confirmed_time: '07:30' };

    const schedules = ev.preferences.schedules || [];
    const weekday = schedules.find(s => WEEKDAYS.includes(s.dayOfWeek));
    if (!weekday) return { confirmed_limit: 80, confirmed_time: '07:30' };

    // time may arrive as 'HH:MM:SS' or 'HH:MM' — normalise to 'HH:MM'
    const time = weekday.time ? weekday.time.substring(0, 5) : '07:30';
    // toNumber: '' / '  ' / 'abc' give null (Number('') would give 0); a 0% target is never real
    const maxValue = toNumber(weekday.max);
    return {
        // Float scalars can arrive as JSON strings; this value is sent back in setDevicePreferences
        confirmed_limit: maxValue !== null && maxValue > 0 ? maxValue : 80,
        confirmed_time: time,
    };
}

// energyAddedKwh can arrive as a string; anything non-numeric counts as no energy, as in
// total_energy, so the sensor never shows "NaN".
function nextKwh(slot) {
    const kwh = slot ? toNumber(slot.energyAddedKwh) : null;
    return kwh !== null ? kwh.toFixed(2) : '0';
}

// data must be merged result: { devices: [...], flexPlannedDispatches: [...] }
// evId: the EV discovery picked (optional); see extractEvDevice.
function parseResponse(data, { tz, serverTz, evId }) {
    const devices = data.devices || [];
    const dispatches = data.flexPlannedDispatches || [];
    const prefs = extractPreferences(devices, evId);

    const now = new Date();
    const active = dispatches.filter(s => new Date(s.end) > now);
    const nextSlot = active[0] || null;
    // energyAddedKwh arrives from live API as a string — coerce before arithmetic
    const sum = active.reduce((acc, s) => acc + (toNumber(s.energyAddedKwh) || 0), 0);
    const totalEnergy = Number.isFinite(sum) ? sum : 0; // never Infinity, even if the values add up past it

    function conv(dt) { return dt ? convertToTimezone(dt, tz) : null; }
    function locale(dt) { return dt ? convertToTimezone(dt, serverTz) : null; }

    return {
        confirmed_limit: prefs.confirmed_limit,
        confirmed_time: prefs.confirmed_time,
        charge_cap: extractChargeCap(devices, evId),
        boosting: extractBoosting(devices, evId),
        device_state: extractDeviceState(devices, evId),
        next_start: nextSlot ? conv(nextSlot.start) : null,
        next_start_raw: nextSlot ? nextSlot.start : null,
        next_start_locale: nextSlot ? locale(nextSlot.start) : null,
        total_energy: parseFloat(totalEnergy.toFixed(2)),
        next_kwh: nextKwh(nextSlot),
        next_source: nextSlot ? (nextSlot.type || 'unknown').toLowerCase() : 'unknown',
        slot1_start: active[0] ? conv(active[0].start) : null,
        slot1_end: active[0] ? conv(active[0].end) : null,
        slot2_start: active[1] ? conv(active[1].start) : null,
        slot2_end: active[1] ? conv(active[1].end) : null,
        slot3_start: active[2] ? conv(active[2].start) : null,
        slot3_end: active[2] ? conv(active[2].end) : null,
        window_start: active.length > 0 ? conv(active[0].start) : null,
        window_end: active.length > 0 ? conv(active[active.length - 1].end) : null,
        slot1_start_raw: active[0] ? active[0].start : null,
        slot1_end_raw: active[0] ? active[0].end : null,
        slot2_start_raw: active[1] ? active[1].start : null,
        slot2_end_raw: active[1] ? active[1].end : null,
        slot3_start_raw: active[2] ? active[2].start : null,
        slot3_end_raw: active[2] ? active[2].end : null,
        window_start_raw: active.length > 0 ? active[0].start : null,
        window_end_raw: active.length > 0 ? active[active.length - 1].end : null,
        slot1_start_locale: active[0] ? locale(active[0].start) : null,
        slot1_end_locale: active[0] ? locale(active[0].end) : null,
        slot2_start_locale: active[1] ? locale(active[1].start) : null,
        slot2_end_locale: active[1] ? locale(active[1].end) : null,
        slot3_start_locale: active[2] ? locale(active[2].start) : null,
        slot3_end_locale: active[2] ? locale(active[2].end) : null,
        window_start_locale: active.length > 0 ? locale(active[0].start) : null,
        window_end_locale: active.length > 0 ? locale(active[active.length - 1].end) : null,
        _activeSlots: active
    };
}

// True when the not-yet-ended slots differ in start/end time. Energy and timestamp
// formatting are ignored — only a moved, added or cancelled slot counts.
function slotsChanged(previous, fresh, nowMs = Date.now()) {
    const key = (slots) => (slots || [])
        .filter(s => new Date(s.end).getTime() > nowMs)
        .map(s => `${new Date(s.start).getTime()}-${new Date(s.end).getTime()}`)
        .join(',');
    return key(previous) !== key(fresh);
}

const defaultData = {
    confirmed_limit: 80, confirmed_time: '07:30', charge_cap: null, boosting: null, device_state: null,
    next_start: null, next_start_raw: null, next_start_locale: null,
    total_energy: 0, next_kwh: '0', next_source: 'unknown',
    slot1_start: null, slot1_end: null, slot2_start: null, slot2_end: null,
    slot3_start: null, slot3_end: null, window_start: null, window_end: null,
    slot1_start_raw: null, slot1_end_raw: null, slot2_start_raw: null, slot2_end_raw: null,
    slot3_start_raw: null, slot3_end_raw: null, window_start_raw: null, window_end_raw: null,
    slot1_start_locale: null, slot1_end_locale: null, slot2_start_locale: null, slot2_end_locale: null,
    slot3_start_locale: null, slot3_end_locale: null, window_start_locale: null, window_end_locale: null,
    _activeSlots: []
};

// parseResponse: text fields cut to the HA state limit (lib/values.js).
module.exports = { buildDevicesQuery, buildDispatchQuery, extractEvDevice, extractSuspended, statusNulledDevices, parseResponse: capStrings(parseResponse), slotsChanged, defaultData };
