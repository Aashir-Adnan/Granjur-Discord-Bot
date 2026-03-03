const logMessage = require("../../SysFunctions/LogFunctions/consoleLog");
const { requestConnection, getDbInstance} = require('./requestConnection');

async function executeQuery(query, values, connection = null, endConnection = true) {
  
  let conn = connection;
  let db;
  if (!query) {logMessage(["Empty/Null Query Provided"]); return [];}
  try {
    if (!conn) {
      conn = await requestConnection();
      endConnection = true;
    }
    db = (await getDbInstance(conn.framework_db_name)).db
    const convertedSyntax = db.convertQuery(query);
    const { query: convertedQuery, values: convertedValues } = db.convertQueryForPostgres(convertedSyntax, values);
    const result = await db.executeQuery(conn, convertedQuery, convertedValues);
    return result;
  } finally {
    if (conn && endConnection) {
      db.releaseConnection(conn);
    }
  }
}

module.exports = { executeQuery };
