// lib/categories/applicable-rates.js
// Half-hourly time-of-use rates for a given electricity supply point.
// Requires MPAN (or MPRN). Returns 30-min slots for the next 24h.
//
// Same parser handles import and export — pass { fieldPrefix } to parseResponse
// and exportFields() to swap the output naming to electricity_export_rate_*.
'use strict';

const QUERY = `
query getApplicableRates($account: String!, $mpxn: String!, $startAt: DateTime!, $endAt: DateTime!) {
    applicableRates(accountNumber: $account, mpxn: $mpxn, startAt: $startAt, endAt: $endAt, first: 48) {
        edges { node { validFrom validTo value } }
    }
}`;

function buildQuery(account, mpan) {
    const startAt = new Date().toISOString();
    const endAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    return { query: QUERY, variables: { account, mpxn: mpan, startAt, endAt } };
}

function _stats(slots) {
    const values = slots
        .map(s => s.value_pence_per_kwh)
        .filter(v => v !== null && v !== undefined);
    if (values.length === 0) {
        return { min: null, max: null, median: null, avg: null };
    }
    const sorted = values.slice().sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const sum = values.reduce((a, v) => a + v, 0);
    const avg = parseFloat((sum / values.length).toFixed(4));
    let median;
    if (sorted.length % 2 === 1) {
        median = sorted[Math.floor(sorted.length / 2)];
    } else {
        const mid = sorted.length / 2;
        median = parseFloat(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(4));
    }
    return { min, max, median, avg };
}

function _emit(prefix, slots, current, prev, next, stats) {
    const pence = current ? current.value_pence_per_kwh : null;
    const prevPence = prev ? prev.value_pence_per_kwh : null;
    const nextPence = next ? next.value_pence_per_kwh : null;
    const out = {};
    out[`${prefix}`] = slots;
    out[`${prefix}_count`] = slots.length;
    out[`${prefix}_current_pence`] = pence;
    out[`${prefix}_current_gbp`] = pence !== null ? parseFloat((pence / 100).toFixed(4)) : null;
    out[`${prefix}_prev_pence`] = prevPence;
    out[`${prefix}_prev_gbp`] = prevPence !== null ? parseFloat((prevPence / 100).toFixed(4)) : null;
    out[`${prefix}_prev_to`] = prev ? prev.valid_to : null;
    out[`${prefix}_next_pence`] = nextPence;
    out[`${prefix}_next_gbp`] = nextPence !== null ? parseFloat((nextPence / 100).toFixed(4)) : null;
    out[`${prefix}_next_from`] = next ? next.valid_from : null;
    out[`${prefix}_error`] = null;
    // v1.5 stats
    out[`${prefix}_min_pence`] = stats.min;
    out[`${prefix}_max_pence`] = stats.max;
    out[`${prefix}_median_pence`] = stats.median;
    out[`${prefix}_avg_pence`] = stats.avg;
    return out;
}

function parseResponse(data, options) {
    const prefix = (options && options.fieldPrefix) || 'applicable_rates';
    const edges = ((data.applicableRates || {}).edges) || [];
    const slots = edges.map(e => ({
        valid_from: e.node.validFrom,
        valid_to: e.node.validTo,
        value_pence_per_kwh: e.node.value !== null ? parseFloat(e.node.value) : null
    }));

    slots.sort((a, b) => new Date(a.valid_from) - new Date(b.valid_from));

    const now = Date.now();
    const currentIdx = slots.findIndex(s => {
        const from = new Date(s.valid_from).getTime();
        const to = new Date(s.valid_to).getTime();
        return now >= from && now < to;
    });

    const current = currentIdx !== -1 ? slots[currentIdx] : null;
    const prev = currentIdx > 0 ? slots[currentIdx - 1] : null;
    const next = (currentIdx !== -1 && currentIdx < slots.length - 1) ? slots[currentIdx + 1] : null;

    const stats = _stats(slots);
    return _emit(prefix, slots, current, prev, next, stats);
}

const defaultData = {
    applicable_rates: [],
    applicable_rates_count: 0,
    applicable_rates_current_pence: null,
    applicable_rates_current_gbp: null,
    applicable_rates_prev_pence: null,
    applicable_rates_prev_gbp: null,
    applicable_rates_prev_to: null,
    applicable_rates_next_pence: null,
    applicable_rates_next_gbp: null,
    applicable_rates_next_from: null,
    applicable_rates_error: null,
    applicable_rates_min_pence: null,
    applicable_rates_max_pence: null,
    applicable_rates_median_pence: null,
    applicable_rates_avg_pence: null,
    electricity_export_rate: [],
    electricity_export_rate_count: 0,
    electricity_export_rate_current_pence: null,
    electricity_export_rate_current_gbp: null,
    electricity_export_rate_prev_pence: null,
    electricity_export_rate_prev_gbp: null,
    electricity_export_rate_prev_to: null,
    electricity_export_rate_next_pence: null,
    electricity_export_rate_next_gbp: null,
    electricity_export_rate_next_from: null,
    electricity_export_rate_error: null,
    electricity_export_rate_min_pence: null,
    electricity_export_rate_max_pence: null,
    electricity_export_rate_median_pence: null,
    electricity_export_rate_avg_pence: null
};

module.exports = { buildQuery, parseResponse, defaultData };
