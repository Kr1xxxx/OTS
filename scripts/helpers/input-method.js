// Typing through an input method: the letters being composed, then the text that is committed.
//
// Chromium takes both from the DevTools protocol, the way the system input method delivers them. Playwright has
// no such channel into WebKit, so there the events an input method produces are dispatched on the focused field:
// compositionstart, for every step the field's new value with an `input` event that says isComposing, and at the
// end compositionend followed by the last `input` (WebKit's order; Chromium sends that `input` first).
async function inputMethod(page) {
  let cdp = null;
  try { cdp = await page.context().newCDPSession(page); } catch (_) { /* not Chromium */ }
  if (cdp) {
    return {
      compose: text => cdp.send('Input.imeSetComposition', { text, selectionStart:text.length, selectionEnd:text.length }),
      commit: text => cdp.send('Input.insertText', { text })
    };
  }
  const step = (text, done) => page.evaluate(({ text, done }) => {
    const field = document.activeElement;
    const session = field.__composing || { before:field.value.slice(0, field.selectionStart), after:field.value.slice(field.selectionEnd) };
    if (!field.__composing && !done) {
      field.__composing = session;
      field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles:true, data:'' }));
    }
    const wasComposing = Boolean(field.__composing);
    field.value = session.before + text + session.after;
    field.setSelectionRange(session.before.length + text.length, session.before.length + text.length);
    if (!done) {
      field.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles:true, data:text }));
      field.dispatchEvent(new InputEvent('input', { bubbles:true, isComposing:true, data:text, inputType:'insertCompositionText' }));
      return;
    }
    delete field.__composing;
    if (wasComposing) field.dispatchEvent(new CompositionEvent('compositionend', { bubbles:true, data:text }));
    field.dispatchEvent(new InputEvent('input', { bubbles:true, isComposing:false, data:text, inputType:wasComposing ? 'insertFromComposition' : 'insertText' }));
  }, { text, done });
  return { compose: text => step(text, false), commit: text => step(text, true) };
}

module.exports = { inputMethod };
