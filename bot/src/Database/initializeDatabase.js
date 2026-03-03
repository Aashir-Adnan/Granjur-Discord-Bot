const logMessage = require("../../SysFunctions/LogFunctions/consoleLog");
const databaseAbstraction = require('./databaseAbstraction');
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

class DatabaseInitializer {
  constructor() {
    this.dbType = databaseAbstraction.getDatabaseType();
  }

  async testConnection(databaseType = 'main') {
    try {
      await databaseAbstraction.initialize();
      await databaseAbstraction.executeQueryWithConnection('SELECT 1 as test', [], databaseType);
      logMessage([` ${databaseType.toUpperCase()} database connection successful (${this.dbType})`]);
      return true;
    } catch (error) {
      console.error(` ${databaseType.toUpperCase()} database connection failed:`, error.message);
      return false;
    }
  }

  getTestQuery() {
    switch (this.dbType) {
      case 'mysql':
      case 'mysql2':
        return 'SELECT 1 as test';
      case 'postgres':
      case 'postgresql':
        return 'SELECT 1 as test';
      default:
        return 'SELECT 1 as test';
    }
  }

  async initialize() {
    logMessage([` Initializing database abstraction layer for ${this.dbType}...`]);
    const mainDbSuccess = await this.testConnection('main');
    const securityDbSuccess = await this.testConnection('security');
    if (mainDbSuccess && securityDbSuccess) {
      logMessage([' All database connections established successfully']);
      return true;
    }
    console.error(' Some database connections failed');
    return false;
  }

  // Helper method to get database-specific features
  getDatabaseFeatures() {
    const features = {
      supportsTransactions: true,
      supportsJSON: true,
      supportsFullTextSearch: true,
      caseSensitive: false
    };

    switch (this.dbType) {
      case 'mysql':
      case 'mysql2':
        features.jsonFunctions = ['JSON_EXTRACT', 'JSON_CONTAINS', 'JSON_ARRAY'];
        features.fullTextSearch = 'MATCH AGAINST';
        break;
      case 'postgres':
      case 'postgresql':
        features.jsonFunctions = ['json_extract_path', 'jsonb_contains', 'jsonb_array_elements'];
        features.fullTextSearch = 'ts_rank';
        features.caseSensitive = true;
        break;
    }

    return features;
  }
}

module.exports = DatabaseInitializer;