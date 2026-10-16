// lib/categories/account.js
'use strict';
const { toNumber } = require('../values');

const QUERY = `
query getAccountBalance($account: String!) {
    account(accountNumber: $account) {
        balance
    }
}`;

function buildQuery(account) {
    return { query: QUERY, variables: { account } };
}

function parseResponse(data) {
    // Kraken numeric scalars can serialise as strings; anything not a finite number is null
    const balancePence = toNumber((data.account || {}).balance);
    return {
        account_balance_pence: balancePence,
        account_balance_pounds: balancePence !== null ? parseFloat((balancePence / 100).toFixed(2)) : null,
        account_error: null
    };
}

const defaultData = {
    account_balance_pence: null,
    account_balance_pounds: null,
    account_error: null
};

module.exports = { buildQuery, parseResponse, defaultData };
