'use strict';

// Kraken can fail a single per-device field (e.g. KT-CT-4360) while returning everything else.
// True when every error sits under `devices[i].<field>` and the device list and those devices
// are still present — i.e. the failure stayed inside that field and the rest is usable.
function onlyDeviceFieldErrors(errors, data, field) {
    if (!Array.isArray(errors) || errors.length === 0) return false;
    const devices = data && data.devices;
    if (!Array.isArray(devices)) return false;
    return errors.every((e) => Array.isArray(e.path)
        && e.path.length >= 3
        && e.path[0] === 'devices'
        && Number.isInteger(e.path[1])
        && devices[e.path[1]] != null
        && e.path[2] === field);
}

module.exports = { onlyDeviceFieldErrors };
