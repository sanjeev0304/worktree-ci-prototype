/**
 * core-engine.js — Restricted Core Auth & Database Layer
 *
 * OWNER: Lead Architect (Person A) ONLY.
 * Person B and Person C must NOT modify this file (see docs/SAFETY_GUARDRAILS.md).
 * The CI gate fails any pull request that touches it.
 *
 * This is a mock: no real network, database or crypto is used.
 */
'use strict';

const crypto = require('crypto');

// Mock user store (hashed passwords would live in a real DB).
const USERS = {
  'alice@enterprise.com': { password: 'admin123', role: 'admin' },
  'bob@enterprise.com': { password: 'finance123', role: 'finance' },
};

// Mock customer table.
const CUSTOMERS = {
  C001: { id: 'C001', name: 'Acme Industries', isVip: true },
  C002: { id: 'C002', name: 'Globex Retail', isVip: false },
};

let connection = null;

/** Opens a mock database connection. Safe to call more than once. */
function connectDatabase(config = {}) {
  if (connection && connection.connected) return connection;
  connection = {
    host: config.host || 'mock-db.internal',
    database: config.database || 'enterprise_invoices',
    connected: true,
    connectedAt: new Date().toISOString(),
  };
  return connection;
}

/** Closes the mock database connection. */
function disconnectDatabase() {
  if (connection) connection.connected = false;
  connection = null;
}

function isConnected() {
  return Boolean(connection && connection.connected);
}

/** Checks credentials and returns a mock session. Throws on failure. */
function authenticate(email, password) {
  const user = USERS[email];
  if (!user || user.password !== password) {
    throw new Error('Authentication failed: invalid credentials');
  }
  return {
    email,
    role: user.role,
    token: crypto.randomBytes(16).toString('hex'),
    issuedAt: Date.now(),
  };
}

/** Throws unless the session looks valid. */
function requireSession(session) {
  if (!session || typeof session.token !== 'string' || session.token.length !== 32) {
    throw new Error('Unauthorized: valid session required');
  }
  return true;
}

/** Looks up a customer. Requires a valid session and an open connection. */
function getCustomer(session, customerId) {
  requireSession(session);
  if (!isConnected()) throw new Error('Database not connected');
  const customer = CUSTOMERS[customerId];
  if (!customer) throw new Error(`Customer not found: ${customerId}`);
  return { ...customer };
}

module.exports = {
  connectDatabase,
  disconnectDatabase,
  isConnected,
  authenticate,
  requireSession,
  getCustomer,
};
