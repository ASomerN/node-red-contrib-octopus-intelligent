'use strict';
const { errorCode, truncate } = require('./graphql-errors');

// Boost charge: charge now, outside the Octopus plan. Not the same as set_smart_charging,
// which suspends or resumes Octopus control (updateDeviceSmartControl).
// Live introspection 6 Oct 2026:
//   updateBoostCharge(input: {deviceId: String!, action: UpdateBoostChargeAction!}) -> SmartFlexDeviceInterface
//   UpdateBoostChargeAction: BOOST | CANCEL
// The result is the device. Only its id is read back (review A2): status is non-null and
// KT-CT-4360 has been seen on it, so an error there would null the answer and make a boost
// that went through look refused. The charging poll that follows reads the state, and it
// tolerates status errors.
const BOOST_MUTATION = `mutation UpdateBoostCharge($deviceId: String!, $action: UpdateBoostChargeAction!) { updateBoostCharge(input: { deviceId: $deviceId, action: $action }) { id } }`;

function buildBoostRequest(deviceId, enabled) {
    return { query: BOOST_MUTATION, variables: { deviceId, action: enabled ? 'BOOST' : 'CANCEL' } };
}

// currentState BOOSTING -> true, any other known state -> false, missing -> null (unknown).
function isBoosting(currentState) {
    if (currentState === null || currentState === undefined) return null;
    return currentState === 'BOOSTING';
}

// Short "KT-CT-xxxx: message" form for logs and the boost_error field, the same form as
// intelligent_error (lib/graphql-errors.js): no trailing full stop, under 255 characters.
function formatKrakenErrors(errors) {
    if (!Array.isArray(errors) || errors.length === 0) return 'Unknown error';
    return truncate(errors.map((e) => {
        const code = errorCode(e);
        const msg = String((e && e.message) || '').trim().replace(/\.+$/, '') || 'Unknown error';
        return code ? `${code}: ${msg}` : msg;
    }).join('; '));
}

// A clean refusal: Octopus failed the mutation itself (errors at updateBoostCharge or with no
// path) and sent no device back. The refusal code has not been seen live, so the handling does
// not depend on it.
function isCleanRefusal(errors, device) {
    return !device && errors.every((e) => !Array.isArray(e && e.path) || e.path.length <= 1);
}

// Octopus can refuse a boost (car unplugged, full, ...). Returns:
//   ok: true                  accepted
//   ok: false, unclear: false a clean refusal: nothing changed on the device
//   ok: false, unclear: true  not clear whether it went through (an error deeper in the
//                             answer, errors next to a device, or no device and no error).
//                             The caller must not flip the boost state: a poll tells.
// A read-back state is not used when there are errors.
function parseBoostResponse(res) {
    const body = (res && res.data) || {};
    const device = (body.data && body.data.updateBoostCharge) || null;
    if (Array.isArray(body.errors) && body.errors.length > 0) {
        const unclear = !isCleanRefusal(body.errors, device);
        return { ok: false, unclear, currentState: null, boosting: null, error: formatKrakenErrors(body.errors) };
    }
    if (!device) {
        return { ok: false, unclear: true, currentState: null, boosting: null, error: 'Boost response had no device' };
    }
    const currentState = device.status && device.status.currentState ? device.status.currentState : null;
    return { ok: true, unclear: false, currentState, boosting: isBoosting(currentState), error: null };
}

function slotActiveAt(slots, now = new Date()) {
    return (slots || []).some((s) => new Date(s.start) <= now && new Date(s.end) > now);
}

// A boost is charging outside the plan, so it counts as charging.
function chargingNowFor(slots, boosting, now = new Date()) {
    return slotActiveAt(slots, now) || boosting === true;
}

// The 10 s reconciliation decision. Returns the corrected charging_now, or null for no change.
// With no slots and no boost it does nothing, as before boosts existed.
function reconcileChargingNow({ slots, boosting, chargingNow, now = new Date() }) {
    const hasSlots = Array.isArray(slots) && slots.length > 0;
    if (!hasSlots && boosting !== true) return null;
    const shouldBeCharging = chargingNowFor(slots, boosting, now);
    return shouldBeCharging === chargingNow ? null : shouldBeCharging;
}

module.exports = {
    BOOST_MUTATION, buildBoostRequest, parseBoostResponse, formatKrakenErrors,
    isBoosting, slotActiveAt, chargingNowFor, reconcileChargingNow,
};
