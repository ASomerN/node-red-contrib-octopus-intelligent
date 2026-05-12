// lib/discovery.js
'use strict';
const { graphqlPost } = require('./graphql');
const { obtainToken } = require('./auth');

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
        id
        deviceType
        status { isSuspended }
    }
}`;

function parseDiscovery(data) {
    const acct = data.account || {};
    const devices = data.devices || [];
    const evDevice = devices.find(d => d.deviceType === 'ELECTRIC_VEHICLES') || null;
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
        hasElectricity: (acct.electricityAgreements || []).length > 0,
        hasGas: (acct.gasAgreements || []).length > 0,
        deviceId: evDevice ? evDevice.id : null,
        deviceSuspended: evDevice ? evDevice.status.isSuspended : null,
        smartMeterDeviceId,
        electricityMpan: importPoint ? importPoint.mpan : null,
        electricityExportMpan: exportPoint ? exportPoint.mpan : null,
        electricitySerial: firstImportMeter ? firstImportMeter.serialNumber : null,
        gasMprn: gasPoints[0] ? gasPoints[0].mprn : null,
        gasSerial: gasPoints[0] && gasPoints[0].meters[0] ? gasPoints[0].meters[0].serialNumber : null
    };
}

async function discoverProducts(apiKey, account) {
    const token = await obtainToken(apiKey);
    const response = await graphqlPost({ query: DISCOVERY_QUERY, variables: { account } }, token);
    if (response.data.errors) {
        throw new Error(`Discovery failed: ${JSON.stringify(response.data.errors)}`);
    }
    if (!response.data.data) {
        throw new Error('Discovery response missing data');
    }
    return parseDiscovery(response.data.data);
}

module.exports = { discoverProducts, parseDiscovery };
