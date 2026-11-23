// Global small helpers for Optical Shop OMS

// Auto-dismiss flash messages after a few seconds. Exposed as a named
// function (not just a DOMContentLoaded listener) because ajaxSaveInit()
// below needs to re-run it after swapping in a freshly-saved page, since
// that content never fires a fresh DOMContentLoaded.
function initFlashAutoDismiss(scope) {
  (scope || document).querySelectorAll('.flash').forEach(function (el) {
    setTimeout(function () {
      el.style.transition = 'opacity 0.5s';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 500);
    }, 4000);
  });
}
document.addEventListener('DOMContentLoaded', function () {
  initFlashAutoDismiss();
});

// Mobile off-canvas sidebar drawer (staff OMS PWA on a phone screen - see
// the .mobile-topbar/.sidebar-backdrop markup in base.html and the
// max-width:900px rules in style.css). No-op on pages that don't render the
// sidebar (login page, /store, embedded popups), since the elements simply
// won't exist there.
document.addEventListener('DOMContentLoaded', function () {
  var menuBtn = document.getElementById('mobileMenuBtn');
  var sidebar = document.getElementById('appSidebar');
  var backdrop = document.getElementById('sidebarBackdrop');
  if (!menuBtn || !sidebar || !backdrop) return;

  function openDrawer() {
    sidebar.classList.add('mobile-open');
    backdrop.classList.add('mobile-open');
    menuBtn.setAttribute('aria-expanded', 'true');
  }
  function closeDrawer() {
    sidebar.classList.remove('mobile-open');
    backdrop.classList.remove('mobile-open');
    menuBtn.setAttribute('aria-expanded', 'false');
  }
  menuBtn.addEventListener('click', function () {
    if (sidebar.classList.contains('mobile-open')) closeDrawer(); else openDrawer();
  });
  backdrop.addEventListener('click', closeDrawer);
});

// ---------------------------------------------------------------------
// Background ("ajax") form saves.
//
// Any <form data-ajax-save method="POST"> submits in the background via
// fetch() instead of a full browser navigation. Flask's routes are
// untouched - they keep doing their normal "process POST, flash a message,
// redirect(url_for(...))" thing. fetch() follows that redirect itself and
// hands back the resulting page's HTML, which we splice into the current
// page's <main class="content"> (see base.html) in place, update the
// title/URL, and re-run any scripts the new content brought with it (e.g.
// the drag-reorder script on the product gallery, or the banner list's
// reorder script). The visible effect: clicking Save shows a brief
// "Saving..." state and the page updates itself - no full-page reload.
//
// If anything about that doesn't work out (network failure, or the
// response isn't a normal app-shell page) we fall back to a real native
// form submission so a save is never silently lost.
// ---------------------------------------------------------------------
(function () {
  function runScripts(container) {
    Array.from(container.querySelectorAll('script')).forEach(function (oldScript) {
      var newScript = document.createElement('script');
      Array.from(oldScript.attributes).forEach(function (attr) {
        newScript.setAttribute(attr.name, attr.value);
      });
      newScript.textContent = oldScript.textContent;
      oldScript.parentNode.replaceChild(newScript, oldScript);
    });
  }

  function runPageLevelScripts(doc) {
    // Scripts placed in {% block scripts %} live directly under <body>,
    // after the app-shell / bare_content, and are not inside main.content -
    // re-run those too (skipping the shared app.js include itself).
    Array.from(doc.querySelectorAll('body > script')).forEach(function (oldScript) {
      if (oldScript.src && oldScript.src.indexOf('/static/js/app.js') !== -1) return;
      var newScript = document.createElement('script');
      Array.from(oldScript.attributes).forEach(function (attr) {
        newScript.setAttribute(attr.name, attr.value);
      });
      newScript.textContent = oldScript.textContent;
      document.body.appendChild(newScript);
    });
  }

  function swapInPage(html, url) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var newMain = doc.querySelector('main.content');
    var curMain = document.querySelector('main.content');
    if (!newMain || !curMain) {
      // Unexpected response shape (e.g. logged out, permission error page) -
      // do a real navigation rather than guess.
      window.location.href = url;
      return;
    }
    curMain.innerHTML = newMain.innerHTML;
    document.title = doc.title;
    if (url !== window.location.href) {
      history.pushState({ ajaxNav: true }, '', url);
    }
    runScripts(curMain);
    runPageLevelScripts(doc);
    initFlashAutoDismiss(curMain);
    curMain.scrollIntoView({ block: 'start' });
    // Generic hook other scripts can listen for after any ajax-save
    // completes (e.g. the notifications badge refreshing itself after a
    // "Mark read" click) - nothing else in the app currently uses this.
    document.dispatchEvent(new CustomEvent('ajaxSaveComplete'));
  }

  function submitAjaxForm(form) {
    var submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
    var originalLabel = submitBtn ? submitBtn.textContent : null;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.dataset.savingLabel = submitBtn.dataset.savingLabel || 'Saving...';
      submitBtn.textContent = submitBtn.dataset.savingLabel;
    }
    var formData = new FormData(form);
    fetch(form.getAttribute('action') || window.location.href, {
      method: (form.getAttribute('method') || 'POST').toUpperCase(),
      body: formData,
      credentials: 'same-origin',
    })
      .then(function (resp) {
        if (!resp.ok) throw new Error('Request failed with status ' + resp.status);
        return resp.text().then(function (html) {
          return { html: html, url: resp.url };
        });
      })
      .then(function (result) {
        swapInPage(result.html, result.url);
      })
      .catch(function () {
        // Never lose a save silently - fall back to a real submit.
        // form.submit() bypasses the 'submit' event entirely, so this
        // won't loop back into this same handler.
        form.submit();
      })
      .finally(function () {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = originalLabel;
        }
      });
  }

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!form.hasAttribute('data-ajax-save')) return;
    if ((form.getAttribute('method') || 'GET').toUpperCase() !== 'POST') return;
    // Respect an earlier handler that already cancelled this submission -
    // e.g. an onsubmit="return confirm(...)" the user declined. Without
    // this check a declined "Delete this image?" confirm would still go
    // ahead and delete, since our handler runs after the inline one.
    if (e.defaultPrevented) return;
    e.preventDefault();
    submitAjaxForm(form);
  });

  // Keep the back/forward buttons trustworthy after an ajax-swapped save:
  // rather than trying to re-swap old cached HTML (which could go stale or
  // miss re-running scripts correctly), just do one real reload so the
  // page the user lands on is always fully correct.
  window.addEventListener('popstate', function (e) {
    if (e.state && e.state.ajaxNav) {
      window.location.reload();
    }
  });
})();

// "Prescribed By" doctor/optometrist picker - a <select> backed by the
// shared /prescribers.json list, with a "+ New" button that adds a fresh
// name via /prescribers/quick-add and selects it immediately. Reused on the
// standalone prescription form, the inline new-order prescription panel,
// and the lens/contact-lens purchase-order form.
function initPrescriberPicker(opts) {
  const select = document.getElementById(opts.selectId);
  const addBtn = document.getElementById(opts.addBtnId);
  const row = document.getElementById(opts.rowId);
  const input = document.getElementById(opts.inputId);
  const saveBtn = document.getElementById(opts.saveBtnId);
  const cancelBtn = document.getElementById(opts.cancelBtnId);
  if (!select) return;

  function loadOptions(presetValue) {
    const current = presetValue !== undefined ? presetValue : select.value;
    fetch('/prescribers.json').then(r => r.json()).then(data => {
      select.innerHTML = '<option value="">-- Select --</option>';
      (data.prescribers || []).forEach(function (p) {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name;
        select.appendChild(opt);
      });
      if (current) select.value = current;
    });
  }
  loadOptions(opts.presetValue || '');

  if (addBtn && row) {
    addBtn.addEventListener('click', function () {
      row.classList.remove('hidden');
      input.value = '';
      input.focus();
    });
  }
  if (cancelBtn && row) {
    cancelBtn.addEventListener('click', function () { row.classList.add('hidden'); });
  }
  if (saveBtn && input) {
    saveBtn.addEventListener('click', function () {
      const name = input.value.trim();
      if (!name) { alert('Please enter a name.'); return; }
      const fd = new FormData();
      fd.append('name', name);
      fetch('/prescribers/quick-add', { method: 'POST', body: fd })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data.ok) { alert(data.error || 'Could not add.'); return; }
          loadOptions(data.name);
          row.classList.add('hidden');
        });
    });
  }
}

// ----- Storefront header: sticky shrink-on-scroll, mobile hamburger drawer,
// mobile search toggle. Every element is looked up defensively and the
// whole block no-ops if absent, so this runs harmlessly on every page
// (including the staff admin panel, which has none of these elements). -----
function initStoreHeader() {
  var sticky = document.getElementById('storeStickyHeader');
  if (sticky) {
    var applyScrolled = function () {
      sticky.classList.toggle('is-scrolled', window.scrollY > 8);
    };
    applyScrolled();
    window.addEventListener('scroll', applyScrolled, { passive: true });
  }

  var hamburgerBtn = document.getElementById('storeHamburgerBtn');
  var drawer = document.getElementById('storeMobileDrawer');
  var backdrop = document.getElementById('storeMobileDrawerBackdrop');
  var closeBtn = document.getElementById('storeMobileDrawerClose');
  if (hamburgerBtn && drawer && backdrop) {
    var openDrawer = function () {
      backdrop.hidden = false;
      backdrop.offsetHeight; // force a reflow so the opacity transition below actually animates
      drawer.classList.add('is-open');
      backdrop.classList.add('is-open');
      drawer.setAttribute('aria-hidden', 'false');
      hamburgerBtn.setAttribute('aria-expanded', 'true');
      document.body.style.overflow = 'hidden';
    };
    var closeDrawer = function () {
      drawer.classList.remove('is-open');
      backdrop.classList.remove('is-open');
      drawer.setAttribute('aria-hidden', 'true');
      hamburgerBtn.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
      setTimeout(function () { backdrop.hidden = true; }, 250);
    };
    hamburgerBtn.addEventListener('click', openDrawer);
    backdrop.addEventListener('click', closeDrawer);
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
  }

  var mobileSearchBtn = document.getElementById('storeMobileSearchBtn');
  var mobileSearchBar = document.getElementById('storeMobileSearchBar');
  if (mobileSearchBtn && mobileSearchBar) {
    mobileSearchBtn.addEventListener('click', function () {
      var willOpen = !mobileSearchBar.classList.contains('is-open');
      mobileSearchBar.classList.toggle('is-open', willOpen);
      mobileSearchBtn.setAttribute('aria-expanded', String(willOpen));
      if (willOpen) {
        var input = mobileSearchBar.querySelector('input[name="q"]');
        if (input) input.focus();
      }
    });
  }

  // "Visit Us" navbar dropdown (desktop navbar) - click the trigger to show
  // a panel of branches; click a branch name to reveal that branch's
  // address inline (accordion-style, several can be open at once, same UX
  // as the product-page info accordion). Closes on outside click / Escape.
  var visitUsTrigger = document.getElementById('storeVisitUsTrigger');
  var visitUsPanel = document.getElementById('storeVisitUsPanel');
  if (visitUsTrigger && visitUsPanel) {
    var closeVisitUsPanel = function () {
      visitUsPanel.hidden = true;
      visitUsTrigger.setAttribute('aria-expanded', 'false');
    };
    visitUsTrigger.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = visitUsPanel.hidden;
      if (willOpen) {
        // Panel is position:fixed (see style.css comment on
        // .store-navbar-dropdown-panel for why) so its position has to be
        // computed from the trigger's viewport position on every open,
        // rather than relying on CSS top/left relative to a parent.
        var rect = visitUsTrigger.getBoundingClientRect();
        visitUsPanel.style.top = (rect.bottom + 4) + 'px';
        visitUsPanel.style.left = rect.left + 'px';
      }
      visitUsPanel.hidden = !willOpen;
      visitUsTrigger.setAttribute('aria-expanded', String(willOpen));
    });
    visitUsPanel.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', closeVisitUsPanel);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeVisitUsPanel();
    });
    // Fixed-position panel doesn't track scroll on its own - simplest
    // correct behaviour is to just close it if the page scrolls while open.
    window.addEventListener('scroll', function () {
      if (!visitUsPanel.hidden) closeVisitUsPanel();
    }, { passive: true });
  }

  // "Brands" navbar mega-menu (desktop) - same fixed-position /
  // computed-on-open approach as "Visit Us" above (see the CSS comment on
  // .store-navbar-dropdown-panel for why fixed positioning is used), except
  // this panel spans the full navbar width instead of hugging the trigger,
  // since it's a full alphabetical brand grid rather than a small list.
  var brandsTrigger = document.getElementById('storeBrandsTrigger');
  var brandsPanel = document.getElementById('storeBrandsPanel');
  if (brandsTrigger && brandsPanel) {
    var closeBrandsPanel = function () {
      brandsPanel.hidden = true;
      brandsTrigger.setAttribute('aria-expanded', 'false');
    };
    brandsTrigger.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = brandsPanel.hidden;
      if (willOpen) {
        var navContainer = document.querySelector('.store-navbar-inner');
        var navRect = navContainer.getBoundingClientRect();
        brandsPanel.style.top = (navRect.bottom + 4) + 'px';
        brandsPanel.style.left = navRect.left + 'px';
        brandsPanel.style.width = navRect.width + 'px';
      }
      brandsPanel.hidden = !willOpen;
      brandsTrigger.setAttribute('aria-expanded', String(willOpen));
    });
    brandsPanel.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', closeBrandsPanel);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeBrandsPanel();
    });
    window.addEventListener('scroll', function () {
      if (!brandsPanel.hidden) closeBrandsPanel();
    }, { passive: true });
  }

  // Mobile drawer "Brands" section - single toggle revealing a flat,
  // scrollable list of every brand (no multi-column grid - the drawer is
  // too narrow for that, unlike the desktop mega-menu above).
  var mobileBrandsToggle = document.getElementById('storeMobileBrandsToggle');
  var mobileBrandsList = document.getElementById('storeMobileBrandsList');
  if (mobileBrandsToggle && mobileBrandsList) {
    mobileBrandsToggle.addEventListener('click', function () {
      var open = mobileBrandsToggle.getAttribute('aria-expanded') === 'true';
      mobileBrandsToggle.setAttribute('aria-expanded', String(!open));
      mobileBrandsList.hidden = open;
      var icon = mobileBrandsToggle.querySelector('.store-accordion-icon');
      if (icon) icon.textContent = open ? '+' : '−';
    });
  }
  // Branch name -> address toggle is bound document-wide (not just inside
  // the desktop dropdown) so the same markup/classes work unchanged in the
  // mobile drawer's "Visit Us" section too.
  document.querySelectorAll('.store-visit-us-name').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var addr = btn.nextElementSibling;
      var open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!open));
      addr.hidden = open;
      var icon = btn.querySelector('.store-accordion-icon');
      if (icon) icon.textContent = open ? '+' : '−';
    });
  });
}
document.addEventListener('DOMContentLoaded', initStoreHeader);

// ---------------------------------------------------------------------
// Sidebar "🔔 Notifications" badge - polls the unread count every 30s so
// staff see new orders/delivery-due/review/membership alerts show up live
// without needing to reload or visit the Notifications page. Only runs on
// admin pages (the nav link only exists there - never on /store pages).
// ---------------------------------------------------------------------
(function () {
  var link = document.getElementById('notifications-nav-link');
  if (!link) return;
  function refreshBadge() {
    fetch('/notifications/unread-count.json')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var existing = document.getElementById('notifications-nav-badge');
        var count = data.count || 0;
        if (count > 0) {
          if (existing) {
            existing.textContent = count;
          } else {
            var span = document.createElement('span');
            span.id = 'notifications-nav-badge';
            span.className = 'nav-badge';
            span.textContent = count;
            link.appendChild(document.createTextNode(' '));
            link.appendChild(span);
          }
        } else if (existing) {
          existing.remove();
        }
      })
      .catch(function () {});
  }
  setInterval(refreshBadge, 30000);
  // Also refresh right after any ajax-save form submit completes (e.g. the
  // Notifications page's "Mark read"/"Mark all as read" buttons), so the
  // badge count updates immediately instead of waiting for the next poll.
  document.addEventListener('ajaxSaveComplete', refreshBadge);
})();
