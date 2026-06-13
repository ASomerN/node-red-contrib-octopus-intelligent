// lib/payload.js
'use strict';

function mergePayload(base, newData) {
    return Object.assign({}, base, newData);
}

function buildDefaultPayload(state) {
    if (!state || typeof state !== 'object') {
        throw new TypeError('buildDefaultPayload: state must be an object');
    }
    const { confirmedLimit, confirmedTime, pendingLimit, pendingTime, chargingNow, smartChargingSuspended } = state;
    return {
        // V1 fields — unchanged
        next_start: null, total_energy: 0, next_kwh: '0', next_source: 'unknown',
        confirmed_limit: confirmedLimit, confirmed_time: confirmedTime,
        pending_limit: pendingLimit, pending_time: pendingTime,
        charging_now: chargingNow,
        next_poll: null, next_poll_raw: null,
        refresh_available_at: null,
        api_requests_hour: 0, api_complexity_hour: 0, api_complexity_percent: 0,
        slot1_start: null, slot1_end: null, slot2_start: null, slot2_end: null,
        slot3_start: null, slot3_end: null,
        window_start: null, window_end: null,
        next_start_raw: null,
        slot1_start_raw: null, slot1_end_raw: null, slot2_start_raw: null, slot2_end_raw: null,
        slot3_start_raw: null, slot3_end_raw: null,
        window_start_raw: null, window_end_raw: null,
        timezone_detected: null, timezone_applied: null,
        next_start_locale: null,
        slot1_start_locale: null, slot1_end_locale: null,
        slot2_start_locale: null, slot2_end_locale: null,
        slot3_start_locale: null, slot3_end_locale: null,
        window_start_locale: null, window_end_locale: null,
        smart_charging: smartChargingSuspended === null ? null : !smartChargingSuspended,
        // V2 fields — new categories
        electricity_unit_rate: null, electricity_standing_charge: null,
        electricity_tariff_code: null, electricity_valid_from: null, electricity_valid_to: null,
        electricity_export_unit_rate: null, electricity_export_standing_charge: null,
        electricity_export_tariff_code: null, electricity_export_valid_from: null, electricity_export_valid_to: null,
        electricity_consumption_kwh: null, electricity_consumption_cost: null,
        electricity_consumption_from: null, electricity_consumption_to: null,
        electricity_export_consumption_kwh: null,
        electricity_export_consumption_from: null, electricity_export_consumption_to: null,
        electricity_export_rate: [], electricity_export_rate_count: 0,
        electricity_export_rate_current_pence: null, electricity_export_rate_current_gbp: null,
        electricity_export_rate_prev_pence: null, electricity_export_rate_prev_gbp: null, electricity_export_rate_prev_to: null,
        electricity_export_rate_next_pence: null, electricity_export_rate_next_gbp: null, electricity_export_rate_next_from: null,
        electricity_export_rate_error: null,
        electricity_rates_error: null, electricity_consumption_error: null,
        gas_unit_rate: null, gas_standing_charge: null,
        gas_tariff_code: null, gas_valid_from: null, gas_valid_to: null,
        gas_consumption_kwh: null, gas_consumption_cost: null,
        gas_consumption_from: null, gas_consumption_to: null,
        gas_rates_error: null, gas_consumption_error: null,
        wheel_of_fortune_electricity_spins: null, wheel_of_fortune_electricity_max: null,
        wheel_of_fortune_electricity_used: null,
        wheel_of_fortune_gas_spins: null, wheel_of_fortune_gas_max: null,
        wheel_of_fortune_gas_used: null, wheel_of_fortune_error: null,
        mini_demand_kw: null, mini_consumption_delta_kwh: null, mini_read_at: null, home_mini_error: null,
        saving_session_available: null, saving_session_start: null, saving_session_end: null,
        saving_session_joined: null, saving_session_window_active: null, saving_session_active: null,
        saving_session_points: null, saving_sessions_error: null,
        free_electricity_active: null, free_electricity_available: null,
        free_electricity_start: null, free_electricity_end: null, free_electricity_error: null,
        intelligent_error: null,
        completed_dispatches: [], completed_dispatches_count: 0, completed_dispatches_error: null,
        flex_planned_dispatches: [], flex_planned_dispatches_count: 0, flex_planned_dispatches_error: null,
        applicable_rates: [], applicable_rates_count: 0,
        applicable_rates_current_pence: null, applicable_rates_error: null,
        account_balance_pence: null, account_balance_pounds: null, account_error: null,
        octoplus_enrolled: null, octoplus_enrollment_status: null,
        octoplus_loyalty_points_user: null, octoplus_error: null,
        // v1.5 — tariff rate-band fields (electricity)
        electricity_day_rate: null, electricity_night_rate: null,
        electricity_ev_peak_rate: null, electricity_ev_off_peak_rate: null,
        // v1.5 — 24h schedule stats
        applicable_rates_min_pence: null, applicable_rates_max_pence: null,
        applicable_rates_median_pence: null, applicable_rates_avg_pence: null,
        electricity_export_rate_min_pence: null, electricity_export_rate_max_pence: null,
        electricity_export_rate_median_pence: null, electricity_export_rate_avg_pence: null,
        // v1.5 — update check
        installed_version: null, latest_version: null,
        update_available: false, update_check_at: null, update_check_error: null
    };
}

module.exports = { mergePayload, buildDefaultPayload };
