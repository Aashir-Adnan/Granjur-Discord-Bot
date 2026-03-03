const MySQLDatabase = require('./implementations/MySQLDatabase');
const MySQL2Database = require('./implementations/MySQL2Database');
const PostgreSQLDatabase = require('./implementations/PostgreSQLDatabase');

const mainPrefix = 'DB_';
const securityPrefix = 'SECURITY_DB_';

function buildConfigFromEnv(prefix) {
  const port = process.env[`${prefix}PORT`];
  return {
    host: process.env[`${prefix}HOST`],
    user: process.env[`${prefix}USER`],
    password: process.env[`${prefix}PW`],
    database: process.env[`${prefix}DATABASE`],
    port: port != null && port !== '' ? Number(port) : 3306
  };
}

class DatabaseFactory {
  static createDatabase(
    dbType,
    config
  ) {
    const isPlainObject = config && typeof config === 'object' && !Array.isArray(config);
    if (!isPlainObject) {
      const prefix = config === 'security' ? securityPrefix : mainPrefix;
      config = buildConfigFromEnv(prefix);
    }

    switch ((dbType || '').toLowerCase()) {
      case 'mysql':
        return new MySQLDatabase(config);
      case 'mysql2':
        return new MySQL2Database(config);
      case 'postgres':
      case 'postgresql':
        return new PostgreSQLDatabase(config);
      default:
        throw new Error(`Unsupported database type: ${dbType}`);
    }
  }

  static getSupportedDatabaseTypes() {
    return ['mysql', 'mysql2', 'postgres', 'postgresql'];
  }
}

module.exports = DatabaseFactory;
