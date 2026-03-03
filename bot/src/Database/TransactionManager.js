const DatabaseFactory = require('./DatabaseFactory');

class TransactionManager {
  constructor(dbType) {
    this.dbType = (dbType || 'mysql').toLowerCase();
    this.mainDatabase = DatabaseFactory.createDatabase(this.dbType, 'main');
    this.securityDatabase = DatabaseFactory.createDatabase(this.dbType, 'security');
  }

  async withTransaction(databaseType, callback) {
    const db = databaseType === 'security' ? this.securityDatabase : this.mainDatabase;
    const connection = db.createConnection();
    try {
      await new Promise((resolve, reject) => connection.connect(err => err ? reject(err) : resolve()));
      await this.begin(connection);
      const result = await callback(connection);
      await this.commit(connection);
      return result;
    } catch (error) {
      try { await this.rollback(connection); } catch (e) {}
      throw error;
    } finally {
      db.closeConnection(connection);
    }
  }

  async begin(connection) {
    const beginSql = this.dbType.includes('postgres') ? 'BEGIN' : 'START TRANSACTION';
    await connection.query(beginSql);
  }

  async commit(connection) { await connection.query('COMMIT'); }
  async rollback(connection) { await connection.query('ROLLBACK'); }
}

module.exports = TransactionManager;


