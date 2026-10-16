// lib/discovery.js
'use strict';
const { graphqlPost } = require('./graphql');
const { obtainToken } = require('./auth');
const { onlyDeviceFieldErrors, statusNulledDevices, errorCode, truncate } = require('./graphql-errors');

const MAX_RAW_ERROR_LENGTH = 8192;

const DISCOVERY_QUERY = `
query discover($account: String!) {
    account(accountNumber: $account) {
        electricityAgreements { validFrom }
        gasAgreements { validFrom }
        properties {
            electricityMeterPoints {
                mpan
                direction
                meters {
                    serialNumber
                    smartImportElectricityMeter { deviceId }
                }
            }
            gasMeterPoints { mprn meters { serialNumber } }
        }
    }
    devices(accountNumber: $account) {
        __typename
        id
        deviceType
        status { isSuspended current }
    }
}`;

// v1.7.0 SmartFlex detection. Kraken's device type enum (KrakenFlexDeviceTypes) has no charge
// point value: a SmartFlexChargePoint is listed as ELECTRIC_VEHICLES, like a SmartFlexVehicle.
// So deviceType alone picks the device Octopus smart-charges, car or charger. __typename is only
// needed for the inverter (its deviceType value has not been seen live, so match loosely).
const isInverterDevice = (d) => d.__typename === 'SmartFlexInverter'
    || (typeof d.deviceType === 'string' && d.deviceType.includes('INVERTER'));

// Asked when an error on the device status nulled the device list: the same devices without
// the status, so discovery still finds the car or charger.
const DEVICES_NO_STATUS_QUERY = `
query discoverDevices($account: String!) {
    devices(accountNumber: $account) {
        __typename
        id
        deviceType
    }
}`;

function parseDiscovery(data) {
    const acct = data.account || {};
    const devices = data.devices || [];
    // Review L4: Kraken can keep a replaced car (RETIRED) in the list, possibly first. Prefer
    // the LIVE one (status.current, read in the same status selection, so no new error
    // exposure), and fall back to the first EV.
    const evDevices = devices.filter(d => d && d.deviceType === 'ELECTRIC_VEHICLES');
    const evDevice = evDevices.find(d => d.status && d.status.current === 'LIVE') || evDevices[0] || null;
    // One device for boost, the charging poll and the vehicle sensors, so Vehicle Device State
    // and the Boost switch never describe two different devices. The node passes deviceId to
    // the charging poll, which then reads this same device.
    const vehicleDevice = evDevice;
    const inverterDevice = devices.find(d => d && isInverterDevice(d)) || null;
    const props = (acct.properties || [])[0] || {};
    const elecPoints = props.electricityMeterPoints || [];
    const gasPoints = props.gasMeterPoints || [];

    // Find import and export meter points by direction. Accounts may have
    // either or both. Position in the array is NOT reliable — observed live
    // (2026-05-11) that the export meter can appear at index 0.
    const importPoint = elecPoints.find(p => p.direction === 'IMPORT') || null;
    const exportPoint = elecPoints.find(p => p.direction === 'EXPORT') || null;

    // Home Mini device ID: scan all meter points for smartImportElectricityMeter.
    let smartMeterDeviceId = null;
    for (const point of elecPoints) {
        for (const meter of (point.meters || [])) {
            if (meter.smartImportElectricityMeter && meter.smartImportElectricityMeter.deviceId) {
                smartMeterDeviceId = meter.smartImportElectricityMeter.deviceId;
                break;
            }
        }
        if (smartMeterDeviceId) break;
    }

    const firstImportMeter = importPoint && importPoint.meters && importPoint.meters[0] ? importPoint.meters[0] : null;

    return {
        hasIntelligent: !!evDevice,
        // 0 for an empty (or missing) list: the node checks again, as that can be transient.
        deviceCount: devices.length,
        hasElectricity: (acct.electricityAgreements || []).length > 0,
        hasGas: (acct.gasAgreements || []).length > 0,
        deviceId: evDevice ? evDevice.id : null,
        deviceSuspended: evDevice && evDevice.status ? evDevice.status.isSuspended : null,
        smartMeterDeviceId,
        // How many devices Octopus listed. 0 can be a transient empty list, so the node only
        // removes SmartFlex entities when the list has devices and none is of that kind.
        deviceCount: devices.filter(Boolean).length,
        vehicleDeviceId: vehicleDevice ? vehicleDevice.id : null,
        inverterDeviceId: inverterDevice ? inverterDevice.id : null,
        electricityMpan: importPoint ? importPoint.mpan : null,
        electricityExportMpan: exportPoint ? exportPoint.mpan : null,
        electricitySerial: firstImportMeter ? firstImportMeter.serialNumber : null,
        gasMprn: gasPoints[0] ? gasPoints[0].mprn : null,
        gasSerial: gasPoints[0] && gasPoints[0].meters[0] ? gasPoints[0].meters[0].serialNumber : null
    };
}

// `isClosed` (optional): true once the node is closed. Checked after each answer, so a late
// answer sends no further query; discovery then fails with "Node closed".
async function discoverProducts(apiKey, account, { isClosed } = {}) {
    const stopIfClosed = () => {
        if (isClosed && isClosed()) throw new Error('Node closed');
    };
    const token = await obtainToken(apiKey);
    stopIfClosed();
    const response = await graphqlPost({ query: DISCOVERY_QUERY, variables: { account } }, token);
    stopIfClosed();
    let errors = response.data.errors;
    let data = response.data.data;
    let statusErrorCode;
    // An error on the device status (KT-CT-4360) nulls the whole device list, and with no
    // device list the node would have no scheduler at all. Ask once more without the status.
    if (data && statusNulledDevices(errors, data)) {
        statusErrorCode = errorCode(errors.find((e) => errorCode(e))) || null;
        const retry = await graphqlPost({ query: DEVICES_NO_STATUS_QUERY, variables: { account } }, token);
        stopIfClosed();
        const retryData = retry.data.data;
        if (retry.data.errors || !retryData || !Array.isArray(retryData.devices)) {
            throw new Error(truncate(`Discovery failed: ${JSON.stringify(retry.data.errors || retry.data)}`, MAX_RAW_ERROR_LENGTH));
        }
        data = Object.assign({}, data, { devices: retryData.devices });
        errors = undefined;
    }
    if (errors) {
        // Kraken can fail just the per-device status resolver (KT-CT-4360, transient) while
        // returning everything else. Treat that as "suspended unknown" instead of failing
        // discovery (which would leave the node with no scheduler).
        if (!onlyDeviceFieldErrors(errors, data, 'status')) {
            throw new Error(truncate(`Discovery failed: ${JSON.stringify(errors)}`, MAX_RAW_ERROR_LENGTH));
        }
    }
    if (!data) {
        throw new Error('Discovery response missing data');
    }
    const result = parseDiscovery(data);
    // Set when the status could not be read: the node logs it once (null when Octopus gave no code).
    if (statusErrorCode !== undefined) result.statusErrorCode = statusErrorCode;
    return result;
}

module.exports = { discoverProducts, parseDiscovery };
