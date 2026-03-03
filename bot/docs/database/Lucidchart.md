# Creating an ERD in Lucidchart and Exporting to SQL

This guide will help you design an ERD in Lucidchart and generate SQL queries for creating the corresponding database tables.

---

## 1. Design the ERD in Lucidchart

1. **Create a new Lucidchart document**.  
2. **Add entities (tables)** using the "Entity" shape.  
3. **Add attributes (fields)** to each entity:
   - Use `snake_case` for all names.
   - Specify **field types** (e.g., `INT`, `VARCHAR(255)`, `BOOLEAN`, `DATETIME`).
   - Define **ENUMs** by listing all possible values.  
   - Only add values to primary or foreign keys if necessary.  
4. **Define relationships** between tables:
   - Use lines to represent foreign keys.  
   - Indicate cardinality (1:1, 1:N, N:M).

---

## 2. Export ERD to SQL

1. Click **File → Export → Database → SQL**.  
2. In the export dialog, select:
   - Use **field type** from the table definitions.  
   - Use **ENUM** where defined.  
   - Ensure **no entries in key columns** unless necessary.  
   - Use **DATETIME**, not TIMESTAMP.  
   - Use **snake_case** for all table and field names.

---

## 3. Review and Adjust SQL

- Check each table for correct field types.  
- Verify all ENUMs have proper entries.  
- Ensure primary keys are defined but no unnecessary default values.  
- Confirm all table and column names use `snake_case`.  
- Save and run the SQL to create tables in your database.

---

**Tip:** Keeping this consistent ensures your database matches your ERD and prevents naming or type errors.
