const DatabaseFactory = require('./DatabaseFactory');

class QueryBuilder {
  constructor(dbType) {
    this.dbType = dbType;
    this.database = DatabaseFactory.createDatabase(dbType);
  }

  buildPaginationQuery(baseQuery, page, limit) {
    const offset = (page - 1) * limit;
    return `${baseQuery} ${this.database.buildLimitOffset(limit, offset)}`;
  }

  buildOrderByClause(sortBy, sortOrder = 'ASC') {
    if (!sortBy) return '';
    return `ORDER BY ${sortBy} ${sortOrder.toUpperCase()}`;
  }

  buildWhereClause(conditions, operator = 'AND') {
    if (!conditions || conditions.length === 0) return '';
    const whereClause = conditions
      .map(({ column, operator: op, value }) => `${column} ${op} ?`)
      .join(` ${operator} `);
    return `WHERE ${whereClause}`;
  }

  buildJoinClause(joins) {
    if (!joins || joins.length === 0) return '';
    return joins.map(({ type = 'INNER', table, on }) => `${type} JOIN ${table} ON ${on}`).join(' ');
  }

  buildSelectWithCount(columns, table, joins = [], whereClause = '') {
    const selectColumns = columns.join(', ');
    const joinClause = this.buildJoinClause(joins);
    const countOver = this.database.buildCountOver();
    return `SELECT ${countOver} AS table_count, ${selectColumns} FROM ${table} ${joinClause} ${whereClause}`;
  }

  convertQuery(query) {
    let q = query;
    if (this.dbType.includes('postgres')) {
      // Convert MySQL functions to PostgreSQL equivalents
      q = q.replace(/GROUP_CONCAT\(([^)]+)\)/g, (_m, content) => this.database.buildGroupConcat(content));
      q = q.replace(/COUNT\(\*\)\s+OVER\s*\(\)/g, this.database.buildCountOver());
      q = q.replace(/CONCAT\(([^)]+)\)/g, (_m, content) => {
        const args = content.split(',').map(s => s.trim());
        return this.database.buildConcat(...args);
      });
      
      //  MySQL date functions to PostgreSQL 
      
      q = q.replace(/NOW\(\)/g, 'CURRENT_TIMESTAMP');
      
      // Then convert DATE_ADD(date, INTERVAL value DAY) -> date + INTERVAL 'value DAY'
      q = q.replace(/DATE_ADD\(([^,]+),\s*INTERVAL\s+(\d+)\s+DAY\)/g, (_m, date, value) => {
        return `${date} + INTERVAL '${value} DAY'`;
      });
      
      //DATEDIFF(date1, date2) -> EXTRACT(day FROM AGE(date2, date1))
      q = q.replace(/DATEDIFF\(([^,]+),\s*([^)]+)\)/g, (_m, date1, date2) => {
        return `EXTRACT(day FROM AGE(${date2}, ${date1}))`;
      });
      
      // boolean comparisons for PostgreSQL
      q = q.replace(/\s+=\s+1\b/g, ' = true');
      q = q.replace(/\s+=\s+0\b/g, ' = false');
      q = q.replace(/\s+!=\s+1\b/g, ' != true');
      q = q.replace(/\s+!=\s+0\b/g, ' != false');
    }
    return q;
  }
}

module.exports = QueryBuilder;

 