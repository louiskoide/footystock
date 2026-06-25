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
    const parts = path.trim().split('.');
    if (parts[0] === 'true') return true;
    if (parts[0] === 'false') return false;
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
          node.addEventListener(name.slice(2).toLowerCase(), v);
          return;
        }
        node.removeAttribute(name);
        if (v != null && typeof v !== 'function' && typeof v !== 'boolean') {
          node.setAttribute(name, String(v));
        } else if (typeof v === 'boolean') {
          node.setAttribute(name, String(v));
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

  function render() {
    if (!componentInstance) return;
    const active = document.activeElement;
    const wasInput = active && active.tagName === 'INPUT' && rootEl.contains(active);
    const selStart = wasInput ? active.selectionStart : null;
    const selEnd = wasInput ? active.selectionEnd : null;

    const vals = componentInstance.renderVals();
    const tmp = document.createElement('div');
    tmp.innerHTML = pristineTemplateHTML;
    processChildren(tmp, [vals]);

    rootEl.innerHTML = '';
    while (tmp.firstChild) rootEl.appendChild(tmp.firstChild);

    if (wasInput) {
      const newInput = rootEl.querySelector('input');
      if (newInput) {
        newInput.focus();
        try { newInput.setSelectionRange(selStart, selEnd); } catch (e) {}
      }
    }
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
