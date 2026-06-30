/* support.js — generated runtime for the `<x-dc>` component template format.
   Do not hand-edit; this interprets the `{{ }}` / sc-for / sc-if directives
   in FootyStock_dc.html generically. App logic lives in that file's
   <script type="text/x-dc"> block, not here. */
(function () {
  'use strict';

  class DCLogic {
    constructor(props) {
      this.props = props || {};
    }
    setState(patch, cb) {
      const next = typeof patch === 'function' ? patch(this.state) : patch;
      this.state = Object.assign({}, this.state, next);
      render();
      if (cb) cb();
    }
  }
  window.DCLogic = DCLogic;

  let componentInstance = null;
  let pristineTemplateHTML = null;
  let rootEl = null;

  const MUSTACHE_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

  function wholeMustache(str) {
    const m = typeof str === 'string' && str.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
    return m ? m[1] : null;
  }

  function resolve(scopeStack, path) {
    const trimmed = path.trim();
    // Ternary: cond ? a : b  (find the ? and : at top level, not inside quotes)
    let depth = 0, qPos = -1, cPos = -1;
    for (let i = 0; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (c === "'" || c === '"') { const q = c; i++; while (i < trimmed.length && trimmed[i] !== q) i++; continue; }
      if (c === '(' || c === '[') { depth++; continue; }
      if (c === ')' || c === ']') { depth--; continue; }
      if (depth === 0 && c === '?' && trimmed[i+1] !== '?' && trimmed[i-1] !== '!' && trimmed[i-1] !== '=') { qPos = i; continue; }
      if (depth === 0 && c === ':' && qPos !== -1) { cPos = i; break; }
    }
    if (qPos !== -1 && cPos !== -1) {
      const cond = resolve(scopeStack, trimmed.slice(0, qPos));
      return cond ? resolve(scopeStack, trimmed.slice(qPos + 1, cPos)) : resolve(scopeStack, trimmed.slice(cPos + 1));
    }
    // Negation: !expr
    if (trimmed.startsWith('!')) return !resolve(scopeStack, trimmed.slice(1));
    // Equality/inequality: a === b, a !== b, a == b, a != b
    const eqMatch = trimmed.match(/^(.+?)\s*(===|!==|==|!=)\s*(.+)$/);
    if (eqMatch) {
      const l = resolve(scopeStack, eqMatch[1]), r = resolve(scopeStack, eqMatch[3].trim());
      if (eqMatch[2] === '===' || eqMatch[2] === '==') return l === r;
      return l !== r;
    }
    // Numeric comparisons: a > b, a >= b, a < b, a <= b
    const cmpMatch = trimmed.match(/^(.+?)\s*(>=|<=|>|<)\s*(.+)$/);
    if (cmpMatch) {
      const l = resolve(scopeStack, cmpMatch[1]), r = resolve(scopeStack, cmpMatch[3].trim());
      if (cmpMatch[2] === '>') return l > r;
      if (cmpMatch[2] === '>=') return l >= r;
      if (cmpMatch[2] === '<') return l < r;
      return l <= r;
    }
    // String concatenation: a + b (only when one side is a string literal)
    const plusMatch = trimmed.match(/^(.+?)\s*\+\s*(.+)$/);
    if (plusMatch) {
      const l = resolve(scopeStack, plusMatch[1]), r = resolve(scopeStack, plusMatch[2]);
      if (l == null && r == null) return undefined;
      return String(l ?? '') + String(r ?? '');
    }
    const parts = trimmed.split('.');
    if (parts[0] === 'true') return true;
    if (parts[0] === 'false') return false;
    // Numeric literal
    if (!isNaN(trimmed) && trimmed !== '') return Number(trimmed);
    // String literal
    if ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
        (trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed.slice(1, -1);
    let val;
    let found = false;
    for (let i = scopeStack.length - 1; i >= 0; i--) {
      if (scopeStack[i] && Object.prototype.hasOwnProperty.call(scopeStack[i], parts[0])) {
        val = scopeStack[i][parts[0]];
        found = true;
        break;
      }
    }
    if (!found) return undefined;
    for (let i = 1; i < parts.length; i++) {
      if (val == null) return val;
      val = val[parts[i]];
    }
    return val;
  }

  function substitute(str, scopeStack) {
    return str.replace(MUSTACHE_RE, (_, expr) => {
      const v = resolve(scopeStack, expr);
      return v == null ? '' : String(v);
    });
  }

  function processChildren(parent, scopeStack) {
    Array.from(parent.childNodes).forEach((child) => {
      const result = processNode(child, scopeStack);
      if (result !== child) parent.replaceChild(result, child);
    });
  }

  function processNode(node, scopeStack) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue.indexOf('{{') !== -1) node.nodeValue = substitute(node.nodeValue, scopeStack);
      return node;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return node;
    const tag = node.tagName.toLowerCase();

    if (tag === 'sc-if') {
      const expr = wholeMustache(node.getAttribute('value'));
      const truthy = expr ? !!resolve(scopeStack, expr) : !!node.getAttribute('value');
      const frag = document.createDocumentFragment();
      if (truthy) {
        Array.from(node.childNodes).forEach((child) => {
          frag.appendChild(processNode(child.cloneNode(true), scopeStack));
        });
      }
      return frag;
    }

    if (tag === 'sc-for') {
      const listExpr = wholeMustache(node.getAttribute('list'));
      const asName = node.getAttribute('as');
      const list = (listExpr ? resolve(scopeStack, listExpr) : null) || [];
      const templateChild = node.firstElementChild;
      const frag = document.createDocumentFragment();
      if (templateChild) {
        list.forEach((item) => {
          const scope = {};
          scope[asName] = item;
          frag.appendChild(processNode(templateChild.cloneNode(true), scopeStack.concat([scope])));
        });
      }
      return frag;
    }

    // regular element: bind attributes
    Array.from(node.attributes).forEach((attr) => {
      const name = attr.name;
      const value = attr.value;
      if (value.indexOf('{{') === -1) return;

      if (name === 'style-hover') {
        node.__hoverStyle = substitute(value, scopeStack);
        node.removeAttribute('style-hover');
        return;
      }
      if (name.indexOf('hint-placeholder') === 0) {
        node.removeAttribute(name);
        return;
      }

      const whole = wholeMustache(value);
      if (whole) {
        const v = resolve(scopeStack, whole);
        if (name.indexOf('on') === 0 && typeof v === 'function') {
          node.removeAttribute(name);
          const evName = name.slice(2).toLowerCase();
          const opts = ['touchstart','touchmove','touchend','touchcancel'].includes(evName) ? {passive:false} : undefined;
          node.addEventListener(evName, v, opts);
          return;
        }
        node.removeAttribute(name);
        if (v != null && typeof v !== 'function' && typeof v !== 'boolean') {
          node.setAttribute(name, String(v));
        } else if (typeof v === 'boolean') {
          if (v) node.setAttribute(name, '');
          else node.removeAttribute(name);
        }
      } else {
        node.setAttribute(name, substitute(value, scopeStack));
      }
    });

    if (node.hasAttribute('style')) node.__baseStyle = node.getAttribute('style');
    if (node.__hoverStyle) {
      node.addEventListener('mouseenter', () => node.setAttribute('style', node.__hoverStyle));
      node.addEventListener('mouseleave', () => node.setAttribute('style', node.__baseStyle || ''));
    }

    processChildren(node, scopeStack);
    return node;
  }

  function childPath(el, root) {
    const path = [];
    let n = el;
    while (n && n !== root) {
      const parent = n.parentNode;
      if (!parent) return null;
      path.unshift(Array.prototype.indexOf.call(parent.childNodes, n));
      n = parent;
    }
    return n === root ? path : null;
  }

  function nodeAtPath(root, path) {
    let n = root;
    for (const i of path) {
      n = n && n.childNodes[i];
      if (!n) return null;
    }
    return n;
  }

  // capture scrollTop/scrollLeft for the window and for any scrollable
  // descendant (e.g. the max-height:560px;overflow-y:auto rankings list),
  // keyed by childNode path so they can be re-applied to the equivalent
  // element after the DOM is rebuilt from scratch
  function captureScroll() {
    const entries = [{ path: null, top: window.scrollY, left: window.scrollX }];
    const all = rootEl.querySelectorAll('*');
    for (const el of all) {
      if ((el.scrollTop || el.scrollLeft) && el.scrollHeight > el.clientHeight) {
        const path = childPath(el, rootEl);
        if (path) entries.push({ path, top: el.scrollTop, left: el.scrollLeft });
      }
    }
    return entries;
  }

  function restoreScroll(entries) {
    for (const e of entries) {
      if (e.path === null) { window.scrollTo(e.left, e.top); continue; }
      const el = nodeAtPath(rootEl, e.path);
      if (el) { el.scrollTop = e.top; el.scrollLeft = e.left; }
    }
  }

  function render() {
    if (!componentInstance) return;
    const active = document.activeElement;
    const wasInput = active && active.tagName === 'INPUT' && rootEl.contains(active);
    const wasTextarea = active && active.tagName === 'TEXTAREA' && rootEl.contains(active);
    const activeInputId = wasInput ? active.id : null;
    const activeTextareaId = wasTextarea ? active.id : null;
    const selStart = (wasInput || wasTextarea) ? active.selectionStart : null;
    const selEnd = (wasInput || wasTextarea) ? active.selectionEnd : null;
    const scrollEntries = captureScroll();

    // snapshot textarea and uncontrolled input values before wiping the DOM
    const textareaSnapshots = {};
    rootEl.querySelectorAll('textarea[id]').forEach(ta => {
      if (ta.value) textareaSnapshots[ta.id] = ta.value;
    });
    // Build set of input ids that have a state-bound value="{{ }}" in the pristine template.
    const controlledInputIds = new Set();
    const tmpCheck = document.createElement('div');
    tmpCheck.innerHTML = pristineTemplateHTML;
    tmpCheck.querySelectorAll('input[id]').forEach(inp => {
      if ((inp.getAttribute('value') || '').includes('{{')) controlledInputIds.add(inp.id);
    });
    const inputSnapshots = {};
    rootEl.querySelectorAll('input[id]').forEach(inp => {
      // Skip controlled inputs — their value comes from state, not user typing.
      if (inp.value && !controlledInputIds.has(inp.id)) inputSnapshots[inp.id] = inp.value;
    });

    const vals = componentInstance.renderVals();
    const tmp = document.createElement('div');
    tmp.innerHTML = pristineTemplateHTML;
    processChildren(tmp, [vals]);

    rootEl.innerHTML = '';
    while (tmp.firstChild) rootEl.appendChild(tmp.firstChild);

    // restore textarea and uncontrolled input values after re-render
    Object.entries(textareaSnapshots).forEach(([id, val]) => {
      const ta = rootEl.querySelector('textarea#' + id);
      if (ta) ta.value = val;
    });
    Object.entries(inputSnapshots).forEach(([id, val]) => {
      const inp = rootEl.querySelector('input#' + id);
      if (inp) inp.value = val;
    });

    if (wasTextarea) {
      const newTa = activeTextareaId
        ? rootEl.querySelector('textarea#' + activeTextareaId)
        : rootEl.querySelector('textarea');
      if (newTa) {
        newTa.focus({ preventScroll: true });
        try { newTa.setSelectionRange(selStart, selEnd); } catch (e) {}
      }
    } else if (wasInput) {
      const newInput = activeInputId
        ? rootEl.querySelector('input#' + activeInputId)
        : rootEl.querySelector('input');
      if (newInput) {
        newInput.focus({ preventScroll: true });
        try { newInput.setSelectionRange(selStart, selEnd); } catch (e) {}
      }
    }
    // rebuilding the DOM via innerHTML drops all scroll positions (window and
    // any internal overflow:auto containers) — restore them so the periodic
    // live-price re-render doesn't jolt the page back to the top.
    // Skip window scroll restore when an input/textarea is focused — the
    // browser handles scroll-into-view for the focused element, and restoring
    // window.scrollY here causes the search-bar jump while typing.
    restoreScroll(scrollEntries.filter(e => e.path !== null || (!wasInput && !wasTextarea)));
  }

  window.addEventListener('DOMContentLoaded', () => {
    const xdc = document.querySelector('x-dc');
    if (!xdc) return;

    const helmet = xdc.querySelector('helmet');
    if (helmet) {
      Array.from(helmet.children).forEach((c) => document.head.appendChild(c));
      helmet.remove();
    }

    const scriptTag = document.querySelector('script[data-dc-script]');
    const code = scriptTag ? scriptTag.textContent : '';
    if (scriptTag) scriptTag.remove();

    rootEl = xdc;
    pristineTemplateHTML = xdc.innerHTML;

    const ComponentClass = new Function(code + '\nreturn Component;')();
    componentInstance = new ComponentClass({});
    if (componentInstance.componentDidMount) componentInstance.componentDidMount();
    render();
  });
})();
