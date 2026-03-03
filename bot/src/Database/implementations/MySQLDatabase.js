const logMessage = require("../../../SysFunctions/LogFunctions/consoleLog");
const BaseDatabase = require('../BaseDatabase');

class MySQLDatabase extends BaseDatabase {
  initializeDriver() {
    this.driver = require('mysql');
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


  //UTLITY QUERIES
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
      WHERE table_schema = '${this.config.database}'
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
      WHERE table_schema = '${this.database}';
    `;
  }

  getTableColumnsQuery() {
    return `
      SELECT 
        c.TABLE_NAME,
        c.COLUMN_NAME, 
        c.COLUMN_KEY,
        c.IS_NULLABLE,
        c.DATA_TYPE,
        c.COLUMN_TYPE,
        k.REFERENCED_TABLE_NAME, 
        k.REFERENCED_COLUMN_NAME, 
        k.CONSTRAINT_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS c
      LEFT JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
        ON c.TABLE_SCHEMA = k.TABLE_SCHEMA 
       AND c.TABLE_NAME = k.TABLE_NAME 
       AND c.COLUMN_NAME = k.COLUMN_NAME
      WHERE c.TABLE_SCHEMA = ?
        AND c.TABLE_NAME = ?
      ORDER BY c.ORDINAL_POSITION ASC
    `;
  }

  getReferenceCountQuery() {
    return `
      SELECT COUNT(*) AS REF_COUNT
      FROM information_schema.key_column_usage
      WHERE referenced_table_schema = ?
        AND referenced_table_name = ?
    `;
  }

  getReferencedTablesQuery() {
    return `
      SELECT REFERENCED_TABLE_NAME
      FROM information_schema.key_column_usage
      WHERE table_schema = ?
        AND table_name = ?
        AND referenced_table_name IS NOT NULL
    `;
  }

  getReferencingTablesQuery() {
    return `
      SELECT TABLE_NAME
      FROM information_schema.key_column_usage
      WHERE table_schema = ?
        AND referenced_table_name = ?
        AND column_name NOT IN ('UpdatedBy', 'updatedBy')
    `;
  }

  getInsertQuery(table_name, attributes = [], values = []){
    if (!Array.isArray(attributes) || !Array.isArray(values)) {
      throw new Error("Attributes and values must be arrays");
    }
    if (attributes.length !== values.length) {
      throw new Error("Attributes and values must be of the same length");
    }

    const columns = attributes.join(", ");
    const placeholders = values.map((v) => `'${v}'`).join(", ");
    const query = `INSERT INTO ${table_name} (${columns}) VALUES (${placeholders})`;
    
    return query;

  }
}

module.exports = MySQLDatabase;


