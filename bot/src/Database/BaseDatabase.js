const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

class BaseDatabase {
  constructor(config) {
    this.config = config;
    this.driver = null;
    this.initializeDriver();
  }

  // Abstracts to be implemented by subclasses
  initializeDriver() { throw new Error('initializeDriver() must be implemented by subclass'); }
  createPool() { throw new Error('createPool() must be implemented by subclass'); }
  createConnection() { throw new Error('createConnection() must be implemented by subclass'); }
  async getConnection(_pool) { throw new Error('getConnection() must be implemented by subclass'); }
  async executeQuery(_connection, _query, _values = []) { throw new Error('executeQuery() must be implemented by subclass'); }
  releaseConnection(_connection) { throw new Error('releaseConnection() must be implemented by subclass'); }
  closeConnection(_connection) { throw new Error('closeConnection() must be implemented by subclass'); }
  async closePool(_pool) { throw new Error('closePool() must be implemented by subclass'); }

  // Optional overrides
  convertQueryParameters(query, values) { return { query, values }; }
  getCurrentTimestamp() { throw new Error('getCurrentTimestamp() must be implemented by subclass'); }
  getCurrentDate() { throw new Error('getCurrentDate() must be implemented by subclass'); }
  buildJsonExtract(_column, _path) { throw new Error('buildJsonExtract() must be implemented by subclass'); }
  buildConcat(..._args) { throw new Error('buildConcat() must be implemented by subclass'); }
  buildLike(_column, _pattern, _caseInsensitive = false) { throw new Error('buildLike() must be implemented by subclass'); }
  buildFullTextSearch(_columns, _searchTerm) { throw new Error('buildFullTextSearch() must be implemented by subclass'); }
  buildGroupConcat(_expression, _separator = ',', _distinct = false) { throw new Error('buildGroupConcat() must be implemented by subclass'); }
  buildLimitOffset(_limit, _offset) { throw new Error('buildLimitOffset() must be implemented by subclass'); }
  buildCountOver() { throw new Error('buildCountOver() must be implemented by subclass'); }

  // Common config helpers
  getDefaultPort() { throw new Error('getDefaultPort() must be implemented by subclass'); }
  getDatabaseSpecificConfig(_databaseType) { return {}; }

  getConfiguration(databaseType = 'main') {
    const isSecurity = databaseType === 'security';
    const prefix = isSecurity ? 'SECURITY_DB_' : 'DB_';
    return {
      host: process.env[`${prefix}HOST`],
      user: process.env[`${prefix}USER`],
      password: process.env[`${prefix}PW`],
      database: process.env[`${prefix}DATABASE`],
      port: process.env[`${prefix}PORT`] || this.getDefaultPort(),
      ...this.getDatabaseSpecificConfig(databaseType)
    };
  }

  getDatabaseFeatures() {
    return {
      supportsTransactions: true,
      supportsJSON: true,
      supportsFullTextSearch: true,
      caseSensitive: false,
      supportsGroupConcat: true,
      supportsCountOver: true
    };
  }


  //UTILITY QUERIES:
  fetchTablesInBaseDatabaseQuery() { throw new Error("fetchTablesInDatabaseQuery() must be implemented in sub class") }
  fetchTablesInSecurityDatabaseQuery() { throw new Error("fetchTablesInSecurityDatabaseQuery() must be implemented in sub class") }
  truncateTableQuery(table_name) { throw new Error("emptyDatabase() must be implemented in sub class") }
  disableForeignKeyQuery() { throw new Error("disableForeignKeyQuery() must be implemented in sub class") }
  enableForeignKeyQuery() { throw new Error("enableForeignKeyQuery() must be implemented in sub class") }
  truncateBaseDatabase() { throw new Error("enableForeignKeyQuery() must be implemented in sub class") }
  getTableColumnsQuery() {
    throw new Error("getTableColumnsQuery should be implemented in subclass");
  }

  getReferenceCountQuery() {
    throw new Error("getReferenceCountQuery should be implemented in subclass");
  }

  getReferencedTablesQuery() {
    throw new Error("getReferencedTablesQuery should be implemented in subclass");
  }

  getReferencingTablesQuery() {
    throw new Error("getReferencingTablesQuery should be implemented in subclass");
  }

  getInsertQuery(table_name, attributes = [], values = []){
    throw new Error("getInsertQUery should be implemented in subclass")
  }
}

module.exports = BaseDatabase;


