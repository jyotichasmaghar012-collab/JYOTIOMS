# Optical Shop OMS: Node.js version

This is a Node.js (Express) port of the original Python/Flask app. It has the same features, URLs, templates and database.

## Run

Requires **Node.js 22.5 or newer** (it uses the built-in `node:sqlite`, so there's no native database driver to compile).

```bash
npm install
npm start          # http://localhost:5000
```

On Windows you can also double-click `run_windows.bat`.

The first run creates `data/oms.db` with the default login **admin / admin123**. Change it from Settings → My Password.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5000` | HTTP port |
| `OMS_SECRET_KEY` | (insecure placeholder) | Signs the session cookie. **Set this in production.** |
| `OMS_DB_PATH` | `data/oms.db` | SQLite database file |
| `DEBUG` | `0` | `1` = reload templates on every request and show stack traces |

## Moving over from the Python version

The database schema is unchanged, and password hashes use the same werkzeug format, so existing users can log in as before. To migrate:

1. Stop the Python app.
2. Copy its `data/oms.db` into `node-app/data/`.
3. Copy its `static/uploads/` into `node-app/static/uploads/`.
4. Start the Node app. Pending column migrations run automatically on startup, as they did in Python.

## Daily backup

```bash
npm run backup     # copies data/oms.db to data/backups/, keeps 30 days
```

Schedule it with Windows Task Scheduler or cron.

## Project layout

| Python | Node |
|---|---|
| `app.py` | `app.js`: Express server, login, dashboard, route wiring |
| `db.py` | `db.js`: schema migrations, `get_db()`, settings, pagination |
| `auth.py`, `branches.py`, `notifications.py`, `backup.py` | same names, `.js` |
| `routes/*.py` (Flask blueprints) | `routes/*.js` |
| Jinja2 templates | the same `templates/`, rendered by Nunjucks |
| reportlab (PDFs) | pdfkit, via `lib/pdfcanvas.js` |
| Pillow (image resizing) | sharp, via `lib/images.js` |

Supporting files in `lib/`:

- `core.js`: Flask-style `request`, `session`, `flash`, `url_for`, blueprints, decorators and werkzeug helpers, backed by AsyncLocalStorage.
- `db.js`: wraps `node:sqlite` with the Python `sqlite3` API (`execute`, `fetchone`, `fetchall`, `commit`) and its transaction behaviour: writes are rolled back unless committed.
- `templates.js`: Nunjucks configured to behave like Jinja2.
- `py.js`: Python helpers for rounding, `%`-formatting, dates and `zip`.

### Template differences from Jinja2

Nunjucks is patched in `lib/templates.js` for these Jinja behaviours:

- Python truthiness: empty lists and dicts count as false.
- Tuples.
- Chained `a if x else b if y else c`.
- `is none`, and the `format`, `tojson`, `map` and `selectattr` filters.
- String methods such as `.startswith()` and `.lower()`.

A few templates still needed small edits:

- `{% with %}` became `{% set %}`.
- `include ... with context` was dropped (Nunjucks includes the context by default).
- Two trailing commas in list/dict literals were removed.
- `_pagination.html` uses a `pagination_window()` helper instead of Jinja's `namespace()`.

Run `node scripts/check-templates.js` to compile every template after editing.
