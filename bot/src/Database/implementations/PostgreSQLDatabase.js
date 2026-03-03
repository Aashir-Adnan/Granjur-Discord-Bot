// Enhanced Database/implementations/PostgreSQLDatabase.js
const BaseDatabase = require('../BaseDatabase');

class PostgreSQLDatabase extends BaseDatabase {
  initializeDriver() {
    const { Pool, Client } = require('pg');
    this.driver = { Pool, Client };
  }

  getDefaultPort() {
    return 5432;
  }

  getDatabaseSpecificConfig(databaseType) {
    const prefix = databaseType === 'security' ? 'SECURITY_DB_' : 'DB_';
    return {
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 60000,
      ssl: process.env[`${prefix}SSL`] === 'true' ? { rejectUnauthorized: false } : false
    };
  }

  createPool() {
    return new this.driver.Pool(this.config);
  }

  createConnection() {
    return new this.driver.Client(this.config);
  }

  async getConnection(pool) {
    return await pool.connect();
  }

  async executeQuery(connection, query, values = []) {
    const adaptedValues = this.adaptValuesForPostgreSQL(query, values);
    const res = await connection.query(query, adaptedValues);
    
    return res.rows;
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

  // Convert MySQL-style positional placeholders to PG style
  convertQueryParameters(query, values) {
    let index = 1;
    const converted = query.replace(/\?/g, () => `$${index++}`);
    // Also adapt values during parameter conversion
    const adaptedValues = this.adaptValuesForPostgreSQL(converted, values);
    return { query: converted, values: adaptedValues };
  }

  // Smart value adaptation for PostgreSQL strict typing
  adaptValuesForPostgreSQL(query, values) {
    // Common boolean column patterns
    const booleanColumns = [
      'is_default', 'is_verified', 'is_active', 'is_deleted', 'is_enabled',
      'is_public', 'is_private', 'is_visible', 'is_required', 'is_optional',
      'has_', 'can_', 'should_', 'will_', 'must_'
    ];

    return values?.map((value, index) => {
      // Skip null/undefined values
      if (value === null || value === undefined) {
        return value;
      }

      // Convert empty strings to null for PostgreSQL
      if (value === '') {
        return null;
      }

      // Handle boolean values
      if (value === true || value === false) {
        return value;
      }

      // Handle string booleans
      if (value === 'true') return true;
      if (value === 'false') return false;

      // For 0/1 values, be more aggressive about boolean conversion
      if (value === 0 || value === 1) {
        // Check if this parameter position corresponds to a boolean column
        const shouldBeBoolean = this.isLikelyBooleanParameter(query, index, booleanColumns);
        if (shouldBeBoolean) {
          return Boolean(value);
        }
        // For INSERT/UPDATE queries, be more aggressive with boolean conversion
        if (this.isInsertOrUpdateQuery(query)) {
          return Boolean(value);
        }
        // Otherwise keep as integer
        return value;
      }

      return value;
    });
  }

  // Determine if a parameter at given index is likely a boolean based on query context
  isLikelyBooleanParameter(query, paramIndex, booleanColumns) {
    // Convert query to lowercase for case-insensitive matching
    const lowerQuery = query.toLowerCase();

    // Find all parameter positions in the query
    const paramPositions = [];
    let match;
    const paramRegex = /\$(\d+)/g;
    while ((match = paramRegex.exec(lowerQuery)) !== null) {
      paramPositions.push({
        position: parseInt(match[1]) - 1, // Convert to 0-based index
        placeholder: match[0]
      });
    }

    // Find the parameter position we're analyzing
    const currentParam = paramPositions.find(p => p.position === paramIndex);
    if (!currentParam) return false;

    // Look for boolean column names near this parameter
    const queryBeforeParam = lowerQuery.substring(0, lowerQuery.indexOf(currentParam.placeholder));

    // Check if any boolean column names appear before this parameter
    for (const boolCol of booleanColumns) {
      if (queryBeforeParam.includes(boolCol)) {
        return true;
      }
    }

    return false;
  }

  // Check if this is an INSERT or UPDATE query (where boolean conversion is more likely)
  isInsertOrUpdateQuery(query) {
    const lowerQuery = query.toLowerCase().trim();
    return lowerQuery.startsWith('insert') || lowerQuery.startsWith('update');
  }

  getCurrentTimestamp() { return 'CURRENT_TIMESTAMP'; }
  getCurrentDate() { return 'CURRENT_DATE'; }
  buildJsonExtract(column, path) { return `${column}->>'${path}'`; }
  buildConcat(...args) { return args.join(' || '); }
  buildLike(column, pattern, caseInsensitive = false) { return caseInsensitive ? `${column} ILIKE '${pattern}'` : `${column} LIKE '${pattern}'`; }
  buildFullTextSearch(columns, searchTerm) { return `to_tsvector('english', ${columns.join(' || \' \' || ')}) @@ plainto_tsquery('english', '${searchTerm}')`; }
  buildGroupConcat(expression, separator = ',', distinct = false) { const d = distinct ? 'DISTINCT ' : ''; return `STRING_AGG(${d}${expression}, '${separator}')`; }
  buildLimitOffset(limit, offset) { return `LIMIT ${limit} OFFSET ${offset}`; }
  buildCountOver() { return 'COUNT(*) OVER ()'; }



  //UTLITY QUERIES

  fetchTablesInBaseDatabaseQuery() {
    return `
    SELECT table_schema, table_name AS "TABLE_NAME"
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE' 
      AND table_schema = 'public'
    ORDER BY table_schema, "TABLE_NAME";
  `;
  }

  fetchTablesInSecurityDatabaseQuery() {
    return `
    SELECT table_schema, table_name AS "TABLE_NAME"
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE' 
      AND table_schema = 'public'
    ORDER BY table_schema, "TABLE_NAME";
  `;
  }

  truncateTableQuery(table_name) {
    return `TRUNCATE TABLE "${table_name}" RESTART IDENTITY CASCADE;`;
  }

  disableForeignKeyQuery() {
    return null;
  }

  enableForeignKeyQuery() {
    return null;
  }

  truncateBaseDatabase() {
    return `
    DO $$ DECLARE
        r RECORD;
    BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
            EXECUTE 'TRUNCATE TABLE "' || r.tablename || '" CASCADE;';
        END LOOP;
    END $$;
  `;
  }


  getTableColumnsQuery() {
    return `
      SELECT 
        c.table_name AS "TABLE_NAME",
        c.column_name AS "COLUMN_NAME",
        tc.constraint_type AS "COLUMN_KEY",
        c.is_nullable AS "IS_NULLABLE",
        c.data_type AS "DATA_TYPE",
        CASE 
          WHEN c.character_maximum_length IS NOT NULL 
          THEN c.udt_name || '(' || c.character_maximum_length || ')'
          ELSE c.udt_name
        END AS "COLUMN_TYPE",
        kcu.table_name AS "REFERENCED_TABLE_NAME",
        kcu.column_name AS "REFERENCED_COLUMN_NAME",
        tc.constraint_name AS "CONSTRAINT_NAME"
      FROM information_schema.columns c
      LEFT JOIN information_schema.key_column_usage k
        ON c.table_name = k.table_name
       AND c.column_name = k.column_name
       AND c.table_schema = k.table_schema
      LEFT JOIN information_schema.table_constraints tc
        ON k.constraint_name = tc.constraint_name
       AND k.table_schema = tc.table_schema
      LEFT JOIN information_schema.constraint_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      WHERE c.table_schema = $1
        AND c.table_name = $2
      ORDER BY c.ordinal_position ASC
    `;
  }

  getReferenceCountQuery() {
    return `
      SELECT COUNT(*) AS "REF_COUNT"
      FROM information_schema.key_column_usage
      WHERE constraint_schema = $1
        AND referenced_table_name = $2
    `;
  }

  getReferencedTablesQuery() {
    return `
      SELECT kcu.table_name AS "REFERENCED_TABLE_NAME"
      FROM information_schema.key_column_usage kcu
      JOIN information_schema.table_constraints tc
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.constraint_schema = tc.constraint_schema
      WHERE kcu.constraint_schema = $1
        AND kcu.table_name = $2
        AND kcu.table_name IS NOT NULL
    `;
  }

  getReferencingTablesQuery() {
    return `
      SELECT kcu.table_name AS "TABLE_NAME"
      FROM information_schema.key_column_usage kcu
      JOIN information_schema.table_constraints tc
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.constraint_schema = tc.constraint_schema
      WHERE kcu.constraint_schema = $1
        AND kcu.referenced_table_name = $2
        AND kcu.column_name NOT IN ('UpdatedBy', 'updatedBy')
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
    const query = `INSERT INTO ${table_name} (${columns}) VALUES (${placeholders}) RETURNING *`;
    
    return query;
  }

}

module.exports = PostgreSQLDatabase;