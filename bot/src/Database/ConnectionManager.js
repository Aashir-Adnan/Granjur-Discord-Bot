const DatabaseFactory = require('./DatabaseFactory');

class ConnectionManager {
  constructor(dbType) {
    this.dbType = (dbType || 'mysql').toLowerCase();
    this.mainDatabase = DatabaseFactory.createDatabase(this.dbType, 'main');
    this.securityDatabase = DatabaseFactory.createDatabase(this.dbType, 'security');
    this.mainPool = null;
    this.securityPool = null;
  }

  initializePools() {
    this.mainPool = this.mainDatabase.createPool();
    this.securityPool = this.securityDatabase.createPool();
  }

  async getPool(databaseType = 'main'){
    return databaseType == 'main' ? this.mainPool : this.securityPool
  }
  async getConnection(databaseType = 'main') {
    const pool = databaseType === 'security' ? this.securityPool : this.mainPool;
    const db = databaseType === 'security' ? this.securityDatabase : this.mainDatabase;
    if (!pool) throw new Error(`${databaseType} pool not initialized`);
    return await db.getConnection(pool);
  }

  async executeQuery(query, values = [], databaseType = 'main', connection = null) {
    let conn = connection;
    let shouldRelease = false;
    const db = databaseType === 'security' ? this.securityDatabase : this.mainDatabase;
    try {
      if (!conn) {
        conn = await this.getConnection(databaseType);
        shouldRelease = true;
      }
      const { query: convertedQuery, values: convertedValues } = db.convertQueryParameters(query, values);
      return await db.executeQuery(conn, convertedQuery, convertedValues);
    } finally {
      if (shouldRelease && conn) {
        db.releaseConnection(conn);
      }
    }
  }

  async withConnection(databaseType, callback) {
    const conn = await this.getConnection(databaseType);
    const db = databaseType === 'security' ? this.securityDatabase : this.mainDatabase;
    try {
      return await callback(conn);
    } finally {
      db.releaseConnection(conn);
    }
  }

  async closePools() {
    if (this.mainPool) await this.mainDatabase.closePool(this.mainPool);
    if (this.securityPool) await this.securityDatabase.closePool(this.securityPool);
  }
}

module.exports = ConnectionManager;


