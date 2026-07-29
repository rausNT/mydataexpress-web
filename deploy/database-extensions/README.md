# Database-scoped web adapters

DataExpress does not provide reliable extension version control. Files in this
directory are therefore profiles for one explicitly tested database, not a
global extension library.

Runtime lookup follows the same rule:

- the preferred `.wepas` is stored in the database as `DX_SCRIPTS.KIND = 7`;
- an external adapter may be placed only in
  `/var/lib/dataexpress/extensions/<connection-name>/`;
- root-level `.wepas` files are never selected automatically;
- copying a profile to another connection requires a separate compatibility
  and browser test.

`CAFETERIA/kok80-ExportToExcel4.0b1.wepas` was tested against the CAFETERIA
demo database on 2026-07-29. Its compatibility report changed from 0/3 to 3/3,
and an exported product list was verified as UTF-8 SpreadsheetML.
