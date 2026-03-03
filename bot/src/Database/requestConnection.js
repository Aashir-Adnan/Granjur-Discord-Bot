const DBAbstraction = require('./databaseAbstraction');
const logMessage = require("../../SysFunctions/LogFunctions/consoleLog");
const dbInstances = {};
const prefix = 'DB_';
const requestConnection = async (config = {}) => {
  const dbName = config.database || 'main';
  if (!dbInstances[dbName]) {
    config = {
      host: config.host || process.env[`${prefix}HOST`],
      user: config.user || process.env[`${prefix}USER`],
      password: config.password || process.env[`${prefix}PW`],
      database: config.database || process.env[`${prefix}DATABASE`],
      port: config.port || process.env[`${prefix}PORT`]
    }
    const db = new DBAbstraction(config);
    db.initialize();

    const pool = db.createPool();
    dbInstances[dbName] = { db, pool };
  }

  const { db, pool } = dbInstances[dbName];
  let connection = await db.getConnection(pool)
  connection.framework_db_name = dbName;
  return connection;
};

const deletePool = async (dbName) => {
  const instance = dbInstances[dbName];
  if (!instance) return;

  await instance.db.closePool(instance.pool);
  delete dbInstances[dbName];
};

const getDbInstance = (dbName) => {
  // logMessage(["Getting DB Instance for DB:", dbName])
  // logMessage(["DB Instances:", dbInstances])
  if (!dbInstances[dbName] && dbName == "main") {
    config = {
      host: process.env[`${prefix}HOST`],
      user: process.env[`${prefix}USER`],
      password: process.env[`${prefix}PW`],
      database: process.env[`${prefix}DATABASE`],
      port: process.env[`${prefix}PORT`]
    }
    const db = new DBAbstraction(config);
    db.initialize();

    const pool = db.createPool();
    dbInstances[dbName] = { db, pool };
  }
  return dbInstances[dbName]

}
module.exports = {
  requestConnection,
  deletePool,
  getDbInstance
};
