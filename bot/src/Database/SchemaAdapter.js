const DatabaseFactory = require('./DatabaseFactory');

class SchemaAdapter {
  constructor(dbType) {
    this.dbType = (dbType || 'mysql').toLowerCase();
    this.database = DatabaseFactory.createDatabase(this.dbType);
  }

  convertSchema(mysqlSchema) {
    if (this.dbType.includes('postgres')) {
      return this.convertToPostgres(mysqlSchema);
    }
    return mysqlSchema;
  }

  convertToPostgres(schema) {
    let s = schema;
    s = s.replace(/AUTO_INCREMENT/gi, 'SERIAL');
    s = s.replace(/INT\(\d+\)/gi, 'INTEGER');
    s = s.replace(/TINYINT\(1\)/gi, 'BOOLEAN');
    s = s.replace(/DATETIME/gi, 'TIMESTAMP');
    s = s.replace(/DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP/gi, 'DEFAULT CURRENT_TIMESTAMP');
    s = s.replace(/ENGINE=\w+/gi, '');
    s = s.replace(/DEFAULT CHARSET=\w+/gi, '');
    s = s.replace(/COLLATE=\w+/gi, '');
    return s;
  }

  getTableInfoQuery() {
    if (this.dbType.includes('postgres')) {
      return `
        SELECT 
          column_name,
          data_type,
          is_nullable,
          column_default
        FROM information_schema.columns 
        WHERE table_name = ? AND table_schema = 'public'
        ORDER BY ordinal_position
      `;
    }
    return `
      SELECT 
        COLUMN_NAME as column_name,
        DATA_TYPE as data_type,
        IS_NULLABLE as is_nullable,
        COLUMN_DEFAULT as column_default
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = ? AND TABLE_SCHEMA = ?
      ORDER BY ORDINAL_POSITION
    `;
  }
}

module.exports = SchemaAdapter;


