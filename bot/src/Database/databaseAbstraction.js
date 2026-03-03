const logMessage = require("../../SysFunctions/LogFunctions/consoleLog");
const path = require("path");
const DatabaseFactory = require('./DatabaseFactory');
const ConnectionManager = require('./ConnectionManager');
const TransactionManager = require('./TransactionManager');
const QueryBuilder = require('./queryBuilder');
const SchemaAdapter = require('./SchemaAdapter');



class DatabaseAbstraction {
  constructor(db_config) {
    const DB_TYPE = process.env.DB_TYPE || 'mysql';
    this.dbType = db_config?.dbType || DB_TYPE.toLowerCase();
    this.connectionManager = new ConnectionManager(this.dbType);
    this.transactionManager = new TransactionManager(this.dbType);
    this.queryBuilder = new QueryBuilder(this.dbType);
    this.schemaAdapter = new SchemaAdapter(this.dbType);
    this.initialized = false;
    this.db = null;
    this.db_config = db_config;
  }

  initialize() {
    if (!this.initialized) {
      this.db = DatabaseFactory.createDatabase(this.dbType, this.db_config);
      this.connectionManager.initializePools();
      this.initialized = true;
    }
  }

  getConfiguration(databaseType = 'main') {

    return this.db.getConfiguration(databaseType);
  }

  createPool() {

    return this.db.createPool();
  }

  async closePool(pool) {

    await this.db.closePool(pool);
  }

  createConnection() {

    return this.db.createConnection();
  }

  async getConnection(pool) {

    return await this.db.getConnection(pool);
  }

  async executeQuery(connection, query, values = []) {

    return await this.db.executeQuery(connection, query, values);
  }

  releaseConnection(connection) {

    this.db.releaseConnection(connection);
  }

  closeConnection(connection) {

    this.db.closeConnection(connection);
  }

  convertQueryForPostgres(query, values) {

    return this.db.convertQueryParameters(query, values);
  }

  getDatabaseType() { return this.dbType; }

  // New helpers
  async executeQueryWithConnection(query, values = [], databaseType = 'main') {
    return await this.connectionManager.executeQuery(query, values, databaseType);
  }

  async withConnection(databaseType, callback) {
    return await this.connectionManager.withConnection(databaseType, callback);
  }

  async withTransaction(databaseType, callback) {
    return await this.transactionManager.withTransaction(databaseType, callback);
  }

  buildPaginationQuery(baseQuery, page, limit) { return this.queryBuilder.buildPaginationQuery(baseQuery, page, limit); }
  buildWhereClause(conditions, operator = 'AND') { return this.queryBuilder.buildWhereClause(conditions, operator); }
  buildOrderByClause(sortBy, sortOrder = 'ASC') { return this.queryBuilder.buildOrderByClause(sortBy, sortOrder); }
  convertQuery(query) { return this.queryBuilder.convertQuery(query); }

  getCurrentTimestamp() { return this.db.getCurrentTimestamp(); }
  buildJsonExtract(column, path) { return this.db.buildJsonExtract(column, path); }
  buildConcat(...args) { return this.db.buildConcat(...args); }
  buildLike(column, pattern, caseInsensitive = false) { return this.db.buildLike(column, pattern, caseInsensitive); }
  buildFullTextSearch(columns, searchTerm) { return this.db.buildFullTextSearch(columns, searchTerm); }
  buildGroupConcat(expression, separator = ',', distinct = false) { return this.db.buildGroupConcat(expression, separator, distinct); }
  buildCountOver() { return this.db.buildCountOver(); }

  convertSchema(mysqlSchema) { return this.schemaAdapter.convertSchema(mysqlSchema); }
  getTableInfoQuery() { return this.schemaAdapter.getTableInfoQuery(); }

  async cleanup() { await this.connectionManager.closePools(); }

  async getSecurityConnection() {return await this.connectionManager.getConnection('security')}

  //UTILITY QUERIES 

  fetchTablesInBaseDatabaseQuery() { return this.db.fetchTablesInBaseDatabaseQuery() }
  fetchTablesInSecurityDatabaseQuery() { return this.db.fetchTablesInSecurityDatabaseQuery() }
  truncateTableQuery(table_name) { return this.db.truncateTableQuery(table_name) }
  disableForeignKeyQuery() { return this.db.disableForeignKeyQuery() }
  enableForeignKeyQuery() { return this.db.enableForeignKeyQuery() }
  truncateBaseDatabase() { return this.db.truncateBaseDatabase() }

  getTableColumnsQuery() {
    return this.db.getTableColumnsQuery();
  }

  getReferenceCountQuery() {
    return this.db.getReferenceCountQuery();
  }

  getReferencedTablesQuery() {
    return this.db.getReferencedTablesQuery();
  }

  getReferencingTablesQuery() {
    return this.db.getReferencingTablesQuery();
  }

  getInsertQuery(table_name, attributes = [], values = []){
   return this.db.getInsertQuery(table_name, attributes, values); 
  }
}


module.exports = DatabaseAbstraction;