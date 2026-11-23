'use strict';
const path = require('node:path');
const { createEnv } = require('./templates');
const core = require('./core');

const env = createEnv(path.join(__dirname, '..', 'templates'));
const contextProcessors = [];

/** Register a function returning extra template variables (Flask's
 *  @app.context_processor). Evaluated on every render. Pass a blueprint name
 *  to scope it like Flask's @bp.context_processor (only for requests routed
 *  to that blueprint). */
function context_processor(fn, blueprintName = null) {
  contextProcessors.push({ fn, bp: blueprintName });
  return fn;
}

function templateRequest() {
  const r = core.request;
  return {
    path: r.path,
    full_path: r.full_path,
    method: r.method,
    endpoint: r.endpoint,
    view_args: r.view_args,
    args: r.args,
    form: r.form,
    url: r.url,
    url_root: r.url_root,
    host_url: r.url_root,
    host: r.host,
    base_url: r.url.split('?')[0],
    cookies: r.cookies,
  };
}

function baseContext() {
  const c = core.current();
  const ctx = {
    request: templateRequest(),
    session: c.req.session,
    g: c.g,
    config: {},
    url_for: (endpoint, kw) => core.url_for(endpoint, kw),
    get_flashed_messages: (kw) => core.get_flashed_messages(kw),
    range: (a, b, step) => {
      if (b === undefined) { b = a; a = 0; }
      step = step || 1;
      const out = [];
      for (let i = a; step > 0 ? i < b : i > b; i += step) out.push(i);
      return out;
    },
  };
  const bpName = String(c.endpoint || '').includes('.') ? String(c.endpoint).split('.')[0] : null;
  for (const cp of contextProcessors) {
    if (cp.bp === null || cp.bp === bpName) Object.assign(ctx, cp.fn());
  }
  return ctx;
}

function render_template(name, context = {}) {
  const ctx = Object.assign(baseContext(), context);
  return env.render(name, ctx);
}

function render_template_string(source, context = {}) {
  const ctx = Object.assign(baseContext(), context);
  return env.renderString(source, ctx);
}

env.addGlobal('url_for', (endpoint, kw) => core.url_for(endpoint, kw));

module.exports = { env, render_template, render_template_string, context_processor };
