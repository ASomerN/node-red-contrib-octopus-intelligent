// lib/categories/intelligent.js
'use strict';
const { convertToTimezone } = require('../timezone');

const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];

const DEVICES_QUERY = `
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
    }
}`;

const DISPATCH_QUERY = `
query getDispatches($deviceId: String!) {
    flexPlannedDispatches(deviceId: $deviceId) {
        start end type energyAddedKwh
    }
}`;

function buildDevicesQuery(account) {
    return { query: DEVICES_QUERY, variables: { account } };
}

function buildDispatchQuery(deviceId) {
    return { query: DISPATCH_QUERY, variables: { deviceId } };
}

function extractEvDevice(devices) {
    return (devices || []).find(d => d.deviceType === 'ELECTRIC_VEHICLES') || null;
}

function extractPreferences(devices) {
    const ev = extractEvDevice(devices);
    if (!ev || !ev.preferences) return { confirmed_limit: 80, confirmed_time: '07:30' };

    const schedules = ev.preferences.schedules || [];
    const weekday = schedules.find(s => WEEKDAYS.includes(s.dayOfWeek));
    if (!weekday) return { confirmed_limit: 80, confirmed_time: '07:30' };

    // time may arrive as 'HH:MM:SS' or 'HH:MM' — normalise to 'HH:MM'
    const time = weekday.time ? weekday.time.substring(0, 5) : '07:30';
    return {
        confirmed_limit: weekday.max ?? 80,
        confirmed_time: time,
    };
}

// data must be merged result: { devices: [...], flexPlannedDispatches: [...] }
function parseResponse(data, { tz, serverTz }) {
    const devices = data.devices || [];
    const dispatches = data.flexPlannedDispatches || [];
    const prefs = extractPreferences(devices);

    const now = new Date();
    const active = dispatches.filter(s => new Date(s.end) > now);
    const nextSlot = active[0] || null;
    // energyAddedKwh arrives from live API as a string — coerce before arithmetic
    const totalEnergy = active.reduce((sum, s) => sum + (parseFloat(s.energyAddedKwh) || 0), 0);

    function conv(dt) { return dt ? convertToTimezone(dt, tz) : null; }
    function locale(dt) { return dt ? convertToTimezone(dt, serverTz) : null; }

    return {
        confirmed_limit: prefs.confirmed_limit,
        confirmed_time: prefs.confirmed_time,
        next_start: nextSlot ? conv(nextSlot.start) : null,
        next_start_raw: nextSlot ? nextSlot.start : null,
        next_start_locale: nextSlot ? locale(nextSlot.start) : null,
        total_energy: parseFloat(totalEnergy.toFixed(2)),
        next_kwh: nextSlot && nextSlot.energyAddedKwh != null ? parseFloat(nextSlot.energyAddedKwh).toFixed(2) : '0',
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

const defaultData = {
    confirmed_limit: 80, confirmed_time: '07:30',
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

module.exports = { buildDevicesQuery, buildDispatchQuery, extractEvDevice, parseResponse, defaultData };
