const { requestConnection } = require("./requestConnection");


const securityDB = async () => {
  const prefix = 'SECURITY_DB_';
  const connection = await requestConnection({
    host: process.env[`${prefix}HOST`],
    user: process.env[`${prefix}USER`],
    password: process.env[`${prefix}PW`],
    database: process.env[`${prefix}DATABASE`],
    port: process.env[`${prefix}PORT`]
  });
  return connection;
};

const closePool = async () => {
  await databaseAbstraction.closePool(pool)
}

module.exports = { securityDB, closePool };
