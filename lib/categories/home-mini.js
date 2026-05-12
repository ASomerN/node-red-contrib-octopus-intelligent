'use strict';

const QUERY = `
query getSmartMeterTelemetry($deviceId: String!, $start: DateTime!, $end: DateTime!) {
    smartMeterTelemetry(deviceId: $deviceId, grouping: HALF_HOURLY, start: $start, end: $end) {
        readAt demand consumptionDelta
    }
}`;

function buildQuery(smartMeterDeviceId) {
    const end = new Date().toISOString();
    const start = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    return { query: QUERY, variables: { deviceId: smartMeterDeviceId, start, end } };
}

function parseResponse(data) {
    const readings = data.smartMeterTelemetry || [];
    const latest = readings.length > 0 ? readings[readings.length - 1] : null;

    return {
        // demand is in Watts from API — negative means exporting
        mini_demand_kw: latest && latest.demand != null ? parseFloat(latest.demand) / 1000 : null,
        // consumptionDelta is in Wh per half-hour period
        mini_consumption_delta_kwh: latest && latest.consumptionDelta != null ? parseFloat(latest.consumptionDelta) / 1000 : null,
        mini_read_at: latest ? latest.readAt ?? null : null,
        home_mini_error: null
    };
}

const defaultData = {
    mini_demand_kw: null,
    mini_consumption_delta_kwh: null,
    mini_read_at: null,
    home_mini_error: null
};

module.exports = { buildQuery, parseResponse, defaultData };
