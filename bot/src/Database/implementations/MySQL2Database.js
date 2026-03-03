const logMessage = require("../../../SysFunctions/LogFunctions/consoleLog");
const BaseDatabase = require('../BaseDatabase');

class MySQL2Database extends BaseDatabase {
  initializeDriver() {
    this.driver = require('mysql2');
  }

  getDefaultPort() {
    return 3306;
  }

  getDatabaseSpecificConfig(databaseType) {
    const prefix = databaseType === 'security' ? 'SECURITY_DB_' : 'DB_';
    return {
      timezone: process.env[`${prefix}TIMEZONE`],
      connectionLimit: 10,
      acquireTimeout: 60000,
      timeout: 60000,
      reconnect: true,
      charset: 'utf8mb4'
    };
  }

  createPool() {
    return this.driver.createPool(this.config);
  }

  createConnection() {
    return this.driver.createConnection(this.config);
  }

  async getConnection(pool) {
    return new Promise((resolve, reject) => {
      pool.getConnection((err, connection) => {
        if (err) reject(err);
        else resolve(connection);
      });
    });
  }

  async executeQuery(connection, query, values = []) {
    return new Promise((resolve, reject) => {
      connection.query(query, values, (err, result) => {
        if (err) {logMessage(["Error: Query: ", query]); reject(err);}
        else resolve(result);
      });
    });
  }

  releaseConnection(connection) {
    if (connection) {
      connection.release();
    }
  }

  closeConnection(connection) {
    if (connection) {
      connection.release();
    }
  }

  async closePool(pool) {
    if (pool) {
      await pool.end();
    }
  }

  getCurrentTimestamp() { return 'NOW()'; }
  getCurrentDate() { return 'CURDATE()'; }
  buildJsonExtract(column, path) { return `JSON_EXTRACT(${column}, '${path}')`; }
  buildConcat(...args) { return `CONCAT(${args.join(', ')})`; }
  buildLike(column, pattern, caseInsensitive = false) { return caseInsensitive ? `${column} LIKE '${pattern}' COLLATE utf8mb4_unicode_ci` : `${column} LIKE '${pattern}'`; }
  buildFullTextSearch(columns, searchTerm) { return `MATCH(${columns.join(', ')}) AGAINST('${searchTerm}' IN BOOLEAN MODE)`; }
  buildGroupConcat(expression, separator = ',', distinct = false) { const d = distinct ? 'DISTINCT ' : ''; return `GROUP_CONCAT(${d}${expression} SEPARATOR '${separator}')`; }
  buildLimitOffset(limit, offset) { return `LIMIT ${limit} OFFSET ${offset}`; }
  buildCountOver() { return 'COUNT(*) OVER ()'; }


  fetchTablesInBaseDatabaseQuery() {
    return `
      SELECT TABLE_NAME
      FROM information_schema.tables
      WHERE table_schema = '${this.config.database}'
    `;
  }

  fetchTablesInSecurityDatabaseQuery() {
    return `
      SELECT TABLE_NAME
      FROM information_schema.tables
      WHERE table_schema = '${process.env.SECURITY_DB_NAME}'
    `;
  }

  truncateTableQuery(table_name) {
    return `TRUNCATE TABLE \`${table_name}\``;
  }

  disableForeignKeyQuery() {
    return "SET FOREIGN_KEY_CHECKS = 0;";
  }

  enableForeignKeyQuery() {
    return "SET FOREIGN_KEY_CHECKS = 1;";
  }

  truncateBaseDatabase() {
    return `
      SELECT CONCAT('TRUNCATE TABLE \`', TABLE_NAME, '\`;') AS stmt
      FROM information_schema.tables
      WHERE table_schema = '${this.config.database}';
    `;
  }

}

module.exports = MySQL2Database;


